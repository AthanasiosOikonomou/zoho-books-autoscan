'use strict';

/**
 * Token-bucket rate limiter. `take()` resolves when a token is available.
 * Used to keep Books calls under the per-minute org cap regardless of
 * concurrency.
 */
function createRateLimiter({ perMinute, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const capacity = Math.max(1, perMinute);
  const refillPerMs = capacity / 60000;
  let tokens = capacity;
  let last = now();

  function refill() {
    const t = now();
    tokens = Math.min(capacity, tokens + (t - last) * refillPerMs);
    last = t;
  }

  async function take() {
    for (;;) {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - tokens) / refillPerMs);
      await sleep(waitMs);
    }
  }

  return { take, get available() { refill(); return tokens; } };
}

/**
 * Run `fn(item)` over `items` with at most `concurrency` in flight.
 * `shouldStop()` is consulted before each new item (time budget).
 * Returns results in input order; errors are captured, never thrown.
 */
async function mapWithConcurrency(items, concurrency, fn, { shouldStop = () => false } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;

  async function worker() {
    for (;;) {
      if (stopped || shouldStop()) { stopped = true; return; }
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }

  const workers = [];
  for (let k = 0; k < Math.max(1, concurrency); k++) workers.push(worker());
  await Promise.all(workers);
  return { results, processed: results.filter(Boolean).length, stopped };
}

module.exports = { createRateLimiter, mapWithConcurrency };
