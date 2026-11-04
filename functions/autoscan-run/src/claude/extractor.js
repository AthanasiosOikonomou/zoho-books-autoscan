'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RECORD_INVOICE_TOOL, normaliseExtraction } = require('./schema');

/**
 * Claude extraction: one document in, one normalised extraction out.
 *
 * Cost rules baked in:
 *  - system prompt is cached (cache_control) → 1/10 input price on every doc after the first in a run
 *  - tool_choice forces the schema → no prose, no parsing, no retry for bad JSON
 *  - max_tokens capped
 *  - optional fallback to a stronger model only when confidence is below a threshold (off by default)
 */
const PROMPT_PATH = path.join(__dirname, 'prompt.v7.md');
let promptCache = null;
function loadPrompt() {
  if (!promptCache) promptCache = fs.readFileSync(PROMPT_PATH, 'utf8');
  return promptCache;
}

function buildContentBlock(buffer, mime) {
  const data = buffer.toString('base64');
  if (mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: mime, data } };
}

/**
 * @param {object} deps
 * @param {object} deps.client   Anthropic SDK client (or a fake with messages.create)
 * @param {object} deps.config   config.claude
 * @param {object} deps.logger
 */
function promptVersionOf(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12); }

function renderPrompt(template, vars = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

function createExtractor({ client, config, logger, poExample }) {
  const systemPrompt = renderPrompt(loadPrompt(), { PO_EXAMPLE: poExample || 'PO-00235' });
  const promptVersion = promptVersionOf(systemPrompt); // rendered text → a different PO format is a different prompt version

  async function callModel(model, buffer, mime) {
    const system = config.promptCache
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt;

    const res = await client.messages.create({
      model,
      max_tokens: config.maxOutputTokens,
      system,
      tools: [RECORD_INVOICE_TOOL],
      tool_choice: { type: 'tool', name: RECORD_INVOICE_TOOL.name },
      messages: [{
        role: 'user',
        content: [
          buildContentBlock(buffer, mime),
          { type: 'text', text: 'Extract the fields from this supplier invoice document.' },
        ],
      }],
    }, { timeout: config.timeoutMs, maxRetries: config.maxRetries });

    const toolBlock = (res.content || []).find((b) => b.type === 'tool_use');
    if (!toolBlock) {
      const err = new Error('Claude returned no tool_use block');
      err.code = 'AI_NO_TOOL_USE';
      throw err;
    }
    const usage = res.usage || {};
    return {
      extraction: normaliseExtraction(toolBlock.input),
      usage: {
        model,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
    };
  }

  /**
   * @returns {{extraction, usage, usages:[]}}
   */
  async function extract(buffer, mime) {
    const usages = [];
    let result = await callModel(config.model, buffer, mime);
    usages.push(result.usage);

    if (config.fallbackModel && config.fallbackBelowConfidence > 0 && result.extraction.confidence < config.fallbackBelowConfidence) {
      logger.info('extraction.fallback', { from: config.model, to: config.fallbackModel, confidence: result.extraction.confidence });
      const second = await callModel(config.fallbackModel, buffer, mime);
      usages.push(second.usage);
      if (second.extraction.confidence >= result.extraction.confidence) result = second;
    }

    return { extraction: result.extraction, usage: result.usage, usages };
  }

  return { extract, promptVersion };
}

/** Rough USD estimate for reporting; prices are config-free constants updated by hand. */
const PRICE_PER_M = {
  // model id prefix → { in, out, cacheRead } USD per million tokens
  'claude-haiku-5': { in: 0.10, out: 0.50, cacheRead: 0.01 },
  'claude-haiku-4': { in: 1.00, out: 5.00, cacheRead: 0.10 },
  'claude-sonnet-5': { in: 2.00, out: 10.00, cacheRead: 0.20 },
  'claude-sonnet-4': { in: 3.00, out: 15.00, cacheRead: 0.30 },
};
function estimateCostUsd(usage) {
  const key = Object.keys(PRICE_PER_M).find((k) => String(usage.model || '').startsWith(k));
  const p = PRICE_PER_M[key] || { in: 3, out: 15, cacheRead: 0.3 };
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return (inTok * p.in + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.output_tokens || 0) * p.out) / 1e6;
}

module.exports = { createExtractor, estimateCostUsd, loadPrompt, promptVersionOf, renderPrompt };
