// Nightly accuracy audit. Compares each brand's platform-reported lifetime
// total against the sum of rows on the Comissions sheet. Posts a single Slack
// message listing any brand whose sheet sum is off by more than $50 AND >5%
// from what the platform itself says. Silent on clean nights.
//
// Sources of "platform truth":
//   - SocialSnowball brands (enhance, crbn, friday): read from the
//     `Audit Aggregates` sheet tab, which each SocialSnowball scrape upserts
//     after capturing the /get-payouts-metrics endpoint.
//
// NOT covered in Phase 1 (need their own audit approach):
//   - RPM (rpm-pickleball) — delta-based scraper. The platform reports a
//     cumulative lifetime total, but our sheet only stores deltas captured
//     since tracking started. The two are deliberately not equal. Catching
//     RPM tracking drift needs a different check (e.g. compare sum of
//     RPM Commissions.new_commissions_usd to sum of RPM rows on Comissions),
//     not the lifetime-vs-lifetime comparison this script does.
//   - BixGrow, UpPromote, Affiliatly, GoAffPro, Shortly — need each scraper
//     to capture a platform-side aggregate first (same shape as the
//     SocialSnowball change). Phase 2.
//
// Adding a new platform = (1) modify its scraper to call writeAuditAggregate
// with the platform's lifetime commission total, (2) the new rows automatically
// flow through this script's comparison logic — no script change needed.
import { google } from 'googleapis';
import { readFile } from 'fs/promises';

const TOLERANCE_DOLLARS = 50;
const TOLERANCE_PERCENT = 0.05;

const SOCIAL_SNOWBALL_BRANDS = new Set(['enhance', 'crbn', 'friday']);

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const credsPath = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!spreadsheetId || !credsPath) {
    console.error('❌ GOOGLE_SHEET_ID and GOOGLE_CREDENTIALS_PATH required');
    process.exit(1);
  }

  const credentials = JSON.parse(await readFile(credsPath, 'utf-8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  // 1. Sheet-side totals: sum commission per advertiser_id from Comissions tab
  const main = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Comissions!A:H',
  });
  const rows = main.data.values || [];
  const sheetTotalsCents = {};
  for (let i = 1; i < rows.length; i++) {
    const adv = rows[i][1];
    if (!adv) continue;
    sheetTotalsCents[adv] = (sheetTotalsCents[adv] || 0) + parseInt(rows[i][6] || '0', 10);
  }

  // 2. Platform truth for SocialSnowball brands — read Audit Aggregates tab
  const comparisons = [];
  const aggResp = await sheets.spreadsheets.values
    .get({ spreadsheetId, range: 'Audit Aggregates!A:G' })
    .catch(() => ({ data: { values: [] } }));
  const aggRows = aggResp.data.values || [];
  for (let i = 1; i < aggRows.length; i++) {
    const [advertiserId, platform, , , totalStr, , capturedAt] = aggRows[i];
    if (!advertiserId || !totalStr) continue;
    const platformTotalUsd = parseFloat(totalStr);
    if (!Number.isFinite(platformTotalUsd)) continue;
    comparisons.push({
      advertiserId,
      platformLabel: platform || 'unknown',
      platformTotalUsd,
      capturedAt,
    });
  }

  // (RPM intentionally skipped — see header comment.)

  // 4. Diff and threshold
  const discrepancies = [];
  for (const c of comparisons) {
    const sheetUsd = (sheetTotalsCents[c.advertiserId] || 0) / 100;
    const deltaUsd = sheetUsd - c.platformTotalUsd;
    const absDelta = Math.abs(deltaUsd);
    const pct = c.platformTotalUsd > 0 ? absDelta / c.platformTotalUsd : 0;
    const tripped = absDelta > TOLERANCE_DOLLARS && pct > TOLERANCE_PERCENT;
    const line = `${tripped ? '🚨' : '✓ '} ${c.advertiserId.padEnd(20)} platform $${c.platformTotalUsd.toFixed(2).padStart(11)}  sheet $${sheetUsd.toFixed(2).padStart(11)}  Δ ${deltaUsd >= 0 ? '+' : '-'}$${absDelta.toFixed(2)} (${(pct * 100).toFixed(1)}%)`;
    console.log(line);
    if (tripped) {
      discrepancies.push({
        advertiserId: c.advertiserId,
        platformLabel: c.platformLabel,
        platformTotalUsd: c.platformTotalUsd,
        sheetTotalUsd: sheetUsd,
        deltaUsd,
        deltaPct: pct,
      });
    }
  }

  if (comparisons.length === 0) {
    console.log('\nℹ️  No platform-truth rows available yet. Audit waiting for scrapers to populate Audit Aggregates / RPM Commissions tabs.');
    return;
  }

  if (discrepancies.length === 0) {
    console.log(`\n✅ ${comparisons.length} brand(s) within tolerance — no Slack alert sent`);
    return;
  }

  // 5. Build and post the Slack message
  const lines = [];
  const noun = discrepancies.length === 1 ? 'discrepancy' : 'discrepancies';
  lines.push(`🚨 *Accuracy audit — ${discrepancies.length} ${noun} found*`);
  lines.push('');
  for (const d of discrepancies) {
    const direction = d.deltaUsd >= 0 ? 'sheet is over-counting' : 'sheet is under-counting';
    const sign = d.deltaUsd >= 0 ? '+' : '–';
    lines.push(`*${d.advertiserId}* (${d.platformLabel})`);
    lines.push(`  Platform: $${d.platformTotalUsd.toFixed(2)}   Sheet: $${d.sheetTotalUsd.toFixed(2)}`);
    lines.push(`  Off by ${sign}$${Math.abs(d.deltaUsd).toFixed(2)} (${(d.deltaPct * 100).toFixed(1)}%) — ${direction}`);
    lines.push('');
  }
  lines.push(`_Threshold: alert when off by >$${TOLERANCE_DOLLARS} AND >${TOLERANCE_PERCENT * 100}%_`);
  lines.push(`Sheet: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);

  const message = lines.join('\n');
  console.log('\n' + message);

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('\n⚠️  SLACK_WEBHOOK_URL not set — message above would have been posted to Slack');
    return;
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) {
    console.error(`❌ Slack webhook failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log('\n✅ Slack alert sent to #tech');
}

main().catch((err) => {
  console.error('❌ Accuracy audit failed:', err);
  process.exit(1);
});
