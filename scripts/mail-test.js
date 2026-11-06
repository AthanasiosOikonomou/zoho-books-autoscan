#!/usr/bin/env node
'use strict';
/**
 * Sends one short test email through the transport configured in .env, so SMTP credentials are proven
 * before anything is deployed.
 *
 *   npm run mail-test                 → to REPORT_TO
 *   npm run mail-test -- --to a@b.c   → to that address instead
 *
 * Secrets stay in .env; nothing is printed except the outcome.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fn = (p) => require(path.join(__dirname, '..', 'functions', 'autoscan-run', 'src', p));
const { loadConfig, assertRuntimeConfig } = fn('config');
const { createLogger } = fn('logger');
const { createMailer } = fn('report/mailers');

(async () => {
  const args = process.argv.slice(2);
  const toIdx = args.indexOf('--to');
  const config = assertRuntimeConfig(loadConfig(process.env));
  const to = toIdx >= 0 ? [args[toIdx + 1]] : config.report.to;
  if (!to.length) { console.error('No recipient: set REPORT_TO in .env or pass --to <address>'); process.exit(2); }
  if (config.report.transport !== 'smtp') console.log(`MAIL_TRANSPORT=${config.report.transport} — nothing leaves the machine; set MAIL_TRANSPORT=smtp to test the mailbox.`);
  const logger = createLogger({ level: 'info' });
  const mailer = createMailer({ config, logger });
  const when = new Date().toISOString();
  try {
    await mailer.send({
      to,
      cc: config.report.devCopy,
      from: config.report.from,
      subject: `AutoScan mail test — ${when}`,
      text: `AutoScan can send email from ${config.report.from || config.report.smtp.user} via ${config.report.smtp.host}:${config.report.smtp.port} (${when}).`,
      html: `<p>AutoScan can send email from <b>${config.report.from || config.report.smtp.user}</b> via ${config.report.smtp.host}:${config.report.smtp.port}.</p><p>${when}</p>`,
    });
    console.log(`OK — sent to ${to.join(', ')} from ${config.report.from || config.report.smtp.user} via ${config.report.transport}`);
  } catch (err) {
    const msg = err && (err.response || err.message || String(err));
    console.error(`FAILED — ${msg}`);
    if (/535|authentication|auth/i.test(String(msg))) console.error('Zoho Mail: with two-factor auth on the mailbox, SMTP needs an app-specific password (accounts.zoho.eu → Security → App Passwords), not the login password.');
    if (/553|relay|from/i.test(String(msg))) console.error('The From address must be the mailbox itself or one of its aliases; leave REPORT_FROM empty.');
    process.exit(1);
  }
})();
