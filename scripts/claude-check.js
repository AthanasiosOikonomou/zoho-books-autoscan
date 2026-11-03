#!/usr/bin/env node
'use strict';

/**
 * Verifies the Claude API key, that CLAUDE_MODEL exists for this account,
 * and makes ONE minimal call (≈ 30 tokens, well under $0.0001) to confirm
 * billing works. Prints the models visible to the key.
 *
 *   npm run claude-check
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
  if (!apiKey) { console.error('ANTHROPIC_API_KEY is not set in .env'); process.exit(2); }
  const client = new Anthropic({ apiKey });

  const models = await client.models.list({ limit: 50 });
  const ids = models.data.map((m) => m.id);
  console.log('Models visible to this key:');
  for (const id of ids) console.log(`  ${id}${id === model ? '   <- CLAUDE_MODEL' : ''}`);
  if (!ids.includes(model)) { console.error(`\nCLAUDE_MODEL "${model}" is not in the list above — fix .env`); process.exit(1); }

  const res = await client.messages.create({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with OK' }] });
  const u = res.usage || {};
  console.log(`\nTest call OK on ${model}: ${u.input_tokens} in / ${u.output_tokens} out tokens (cost ≈ $${((u.input_tokens * 0.1 + u.output_tokens * 0.5) / 1e6).toFixed(7)})`);
})().catch((err) => { console.error(err.status ? `${err.status} ${err.message}` : err.message); process.exit(1); });
