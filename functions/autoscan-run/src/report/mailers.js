'use strict';

const fs = require('fs');
const path = require('path');

/** Catalyst Mail — sender must be a verified address in the Catalyst console. */
function createCatalystMailer({ app, logger }) {
  return {
    async send(report) {
      const to = report.to || [];
      if (!to.length) { logger.warn('mail.no_recipients'); return; }
      const email = app.email();
      await email.sendMail({
        from_email: report.from,
        to_email: to,
        cc: report.cc && report.cc.length ? report.cc : undefined,
        subject: report.subject,
        content: report.html,
        html_mode: true,
      });
      logger.info('mail.sent', { to: to.length, subject: report.subject });
    },
  };
}

/** Local — writes the HTML to ./out and prints the text version. */
function createFileMailer({ outDir, logger }) {
  return {
    async send(report) {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
      fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>${report.subject}</title>${report.html}`);
      logger.info('mail.written', { file });
      // eslint-disable-next-line no-console
      console.log('\n' + report.text + '\n');
    },
  };
}

/**
 * SMTP via nodemailer — e.g. Zoho Mail (smtp.zoho.eu:465) with an app-specific password.
 * Needs no Catalyst sender/domain verification. `transport` can be injected for tests.
 */
function createSmtpMailer({ smtp, logger, transport }) {
  const tx = transport || require('nodemailer').createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
  return {
    async send(report) {
      const to = report.to || [];
      if (!to.length) { logger.warn('mail.no_recipients'); return; }
      const info = await tx.sendMail({
        from: report.from || smtp.user, // Zoho Mail rejects a From that is not the account or one of its aliases
        to,
        cc: report.cc && report.cc.length ? report.cc : undefined,
        subject: report.subject,
        html: report.html,
        text: report.text,
      });
      logger.info('mail.sent', { transport: 'smtp', to: to.length, subject: report.subject, message_id: info && info.messageId });
    },
  };
}

/** Log only — no email is sent; the text report is written to the function log (Console → Logs). */
function createLogMailer({ logger }) {
  return {
    async send(report) {
      logger.info('mail.skipped', { transport: 'log', subject: report.subject, to: (report.to || []).length });
      // eslint-disable-next-line no-console
      console.log(`\n===== ${report.subject} =====\n${report.text}\n===== end of report =====`);
    },
  };
}

/** Picks the mailer from config.report.transport. */
function createMailer({ config, app, logger }) {
  if (config.report.transport === 'smtp') return createSmtpMailer({ smtp: config.report.smtp, logger });
  if (config.report.transport === 'catalyst') return createCatalystMailer({ app, logger });
  return createLogMailer({ logger });
}

module.exports = { createCatalystMailer, createSmtpMailer, createLogMailer, createFileMailer, createMailer };
