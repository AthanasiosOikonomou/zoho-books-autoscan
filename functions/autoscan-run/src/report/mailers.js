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

module.exports = { createCatalystMailer, createFileMailer };
