'use strict';

const crypto = require('crypto');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function newRunId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `run_${ts}_${crypto.randomBytes(3).toString('hex')}`;
}

module.exports = { sha256, newRunId };
