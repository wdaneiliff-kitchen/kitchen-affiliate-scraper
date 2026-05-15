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
// For count-based comparisons (when a platform exposes a row count, e.g. from
// pagination metadata, but no separate $ aggregate): same shape as the drift
// audit — alert when off by more than 5 rows AND 5%.
const TOLERANCE_ROWS = 5;
const TOLERANCE_ROW_PERCENT = 0.05;

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
  const sheetCounts = {};
  for (let i = 1; i < rows.length; i++) {
    const adv = rows[i][1];
    if (!adv) continue;
    sheetTotalsCents[adv] = (sheetTotalsCents[adv] || 0) + parseInt(rows[i][6] || '0', 10);
    sheetCounts[adv] = (sheetCounts[adv] || 0) + 1;
  }

  // 2. Platform truth — read Audit Aggregates tab. Each row carries a $ total
  // (paid + outstanding) and/or a row count, depending on what the platform's
  // scraper was able to capture. The audit compares each against the sheet.
  const comparisons = [];
  const aggResp = await sheets.spreadsheets.values
    .get({ spreadsheetId, range: 'Audit Aggregates!A:G' })
    .catch(() => ({ data: { values: [] } }));
  const aggRows = aggResp.data.values || [];
  for (let i = 1; i < aggRows.length; i++) {
    const [advertiserId, platform, , , totalStr, countStr, capturedAt] = aggRows[i];
    if (!advertiserId) continue;
    const platformTotalUsd = parseFloat(totalStr);
    const platformCount = parseInt(countStr, 10);
    const hasUsd = Number.isFinite(platformTotalUsd) && platformTotalUsd > 0;
    const hasCount = Number.isFinite(platformCount) && platformCount > 0;
    if (!hasUsd && !hasCount) continue;
    comparisons.push({
      advertiserId,
      platformLabel: platform || 'unknown',
      platformTotalUsd: hasUsd ? platformTotalUsd : null,
      platformCount: hasCount ? platformCount : null,
      capturedAt,
    });
  }

  // (RPM intentionally skipped — see header comment.)

  // 4. Diff and threshold
  const discrepancies = [];
  for (const c of comparisons) {
    const sheetUsd = (sheetTotalsCents[c.advertiserId] || 0) / 100;
    const sheetCount = sheetCounts[c.advertiserId] || 0;

    let usdLine = '—';
    let usdTripped = false;
    let deltaUsd = 0;
    let pctUsd = 0;
    if (c.platformTotalUsd !== null) {
      deltaUsd = sheetUsd - c.platformTotalUsd;
      const absDelta = Math.abs(deltaUsd);
      pctUsd = c.platformTotalUsd > 0 ? absDelta / c.platformTotalUsd : 0;
      usdTripped = absDelta > TOLERANCE_DOLLARS && pctUsd > TOLERANCE_PERCENT;
      usdLine = `platform $${c.platformTotalUsd.toFixed(2).padStart(11)}  sheet $${sheetUsd.toFixed(2).padStart(11)}  Δ ${deltaUsd >= 0 ? '+' : '-'}$${absDelta.toFixed(2)} (${(pctUsd * 100).toFixed(1)}%)`;
    }

    let countLine = '—';
    let countTripped = false;
    let deltaCount = 0;
    let pctCount = 0;
    if (c.platformCount !== null) {
      deltaCount = sheetCount - c.platformCount;
      const absDelta = Math.abs(deltaCount);
      pctCount = c.platformCount > 0 ? absDelta / c.platformCount : 0;
      countTripped = absDelta > TOLERANCE_ROWS && pctCount > TOLERANCE_ROW_PERCENT;
      countLine = `platform ${String(c.platformCount).padStart(5)} rows  sheet ${String(sheetCount).padStart(5)} rows  Δ ${deltaCount >= 0 ? '+' : ''}${deltaCount} (${(pctCount * 100).toFixed(1)}%)`;
    }

    const tripped = usdTripped || countTripped;
    const marker = tripped ? '🚨' : '✓ ';
    console.log(`${marker} ${c.advertiserId.padEnd(20)}  $: ${usdLine}  |  rows: ${countLine}`);
    if (tripped) {
      discrepancies.push({
        advertiserId: c.advertiserId,
        platformLabel: c.platformLabel,
        platformTotalUsd: c.platformTotalUsd,
        platformCount: c.platformCount,
        sheetTotalUsd: sheetUsd,
        sheetCount,
        deltaUsd,
        deltaCount,
        deltaPctUsd: pctUsd,
        deltaPctCount: pctCount,
        usdTripped,
        countTripped,
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
    lines.push(`*${d.advertiserId}* (${d.platformLabel})`);
    if (d.usdTripped) {
      const sign = d.deltaUsd >= 0 ? '+' : '–';
      const direction = d.deltaUsd >= 0 ? 'sheet is over-counting' : 'sheet is under-counting';
      lines.push(`  $: platform $${d.platformTotalUsd.toFixed(2)}   sheet $${d.sheetTotalUsd.toFixed(2)}   off ${sign}$${Math.abs(d.deltaUsd).toFixed(2)} (${(d.deltaPctUsd * 100).toFixed(1)}%) — ${direction}`);
    }
    if (d.countTripped) {
      const sign = d.deltaCount >= 0 ? '+' : '';
      const direction = d.deltaCount >= 0 ? 'sheet has extra rows' : 'sheet is missing rows';
      lines.push(`  rows: platform ${d.platformCount}   sheet ${d.sheetCount}   off ${sign}${d.deltaCount} (${(d.deltaPctCount * 100).toFixed(1)}%) — ${direction}`);
    }
    lines.push('');
  }
  lines.push(`_Thresholds: $-check >$${TOLERANCE_DOLLARS} AND >${TOLERANCE_PERCENT * 100}%; row-check >${TOLERANCE_ROWS} AND >${TOLERANCE_ROW_PERCENT * 100}%_`);
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
