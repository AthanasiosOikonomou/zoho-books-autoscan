'use strict';

/**
 * Sends the end-of-day digest once per (local) day.
 *   - explicit: job submitted with params { mode: 'daily_report' } (force: true re-sends)
 *   - implicit: called at the end of every normal run; sends when local time >= DAILY_REPORT_HOUR and today's marker is missing
 * The marker is a run_log row `daily_<YYYY-MM-DD>` written only after a successful send, so a failed send is retried by the next run.
 * The digest covers everything since the previous digest's marker (looked up for up to a week back), not the calendar
 * day — runs after DAILY_REPORT_HOUR would otherwise create bills that no digest ever shows.
 */
const { buildDailyReport, dayRange, digestPeriod } = require('./daily');

const LOOKBACK_DAYS = 7;

/** The most recent earlier day's digest marker (yesterday's, normally), or null. */
async function previousDigest({ store, now, timeZone }) {
  for (let i = 1; i <= LOOKBACK_DAYS; i++) {
    const d = dayRange(new Date(now.getTime() - i * 86400000), timeZone);
    const marker = await store.getRunById(`daily_${d.ymd}`);
    if (marker && marker.started) return marker;
  }
  return null;
}

async function sendDailyReportIfDue({ config, store, mailer, logger, now = new Date(), force = false, explicit = false }) {
  const hour = config.report.dailyHour;
  if (!explicit && (hour === null || hour === undefined)) return { sent: false, reason: 'disabled' };
  const day = dayRange(now, config.report.timeZone);
  if (!explicit && day.hour < hour) return { sent: false, reason: 'too_early' };
  const markerId = `daily_${day.ymd}`;
  if (!force) {
    const existing = await store.getRunById(markerId);
    if (existing) return { sent: false, reason: 'already_sent' };
  }
  const prev = await previousDigest({ store, now, timeZone: config.report.timeZone });
  const period = digestPeriod({ now, timeZone: config.report.timeZone, previousSentAt: prev && prev.started });
  const [docs, open, runs] = await Promise.all([
    store.listDocumentsTouchedBetween({ since: period.since, until: period.until }),
    store.listOpenExceptions(),
    store.listRunsBetween({ since: period.since, until: period.until }),
  ]);
  const realRuns = runs.filter((r) => !String(r.run_id || '').startsWith('daily_'));
  const report = buildDailyReport({ day: period, docs, open, runs: realRuns, config });
  await mailer.send(report);
  const stamp = now.toISOString();
  if (!force || !(await store.getRunById(markerId))) {
    await store.recordRun({ run_id: markerId, started: stamp, finished: stamp, status: 'DONE', report_sent: true, docs_seen: docs.length, billed: report.counts.billed, exceptions: report.counts.attention, notes: `daily report: ${report.counts.billed} billed, ${report.counts.credited} credited, ${report.counts.attention} open` });
  }
  logger.info('daily.sent', { day: day.ymd, since: period.since.toISOString(), ...report.counts, to: (report.to || []).length, explicit, force });
  return { sent: true, day: day.ymd, counts: report.counts, report };
}

module.exports = { sendDailyReportIfDue, previousDigest };
