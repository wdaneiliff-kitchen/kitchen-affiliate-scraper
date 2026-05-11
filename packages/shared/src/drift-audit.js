#!/usr/bin/env node
/**
 * Daily drift watchdog.
 *
 * Snapshots per-advertiser row count and commission total to a "Drift Audit"
 * tab. Compares today's snapshot to the most recent prior snapshot and
 * Slack-alerts if any brand drops beyond threshold — meaning the sheet
 * unexpectedly lost rows or dollars overnight.
 *
 * Why this exists: reconcileToSheets makes the sheet a mirror of each source.
 * If reconcile itself silently breaks (e.g. a future regression in the diff
 * logic, or a scraper bug that bypasses the safety guard), the only way to
 * notice is to compare yesterday's state to today's. This watchdog is the
 * defense-in-depth layer that catches a quietly-broken reconcile flow.
 *
 * Trigger: nightly workflow at 11:50pm Central. Idempotent: writing today's
 * snapshot twice in one day is a no-op (latest write wins).
 *
 * Alerting thresholds for "drop": triggered when BOTH absolute and percentage
 * exceed the floor. Tolerates normal cancellation churn (typically <1 row/day
 * per brand) while catching catastrophic failures (mass delete, auth break
 * that returned 0 records and bypassed safety guard, etc).
 */
import { google } from 'googleapis';
import { readFile } from 'fs/promises';
import https from 'node:https';

const SHEET_NAME = 'Comissions';
const AUDIT_TAB = 'Drift Audit';

const THRESH_ROW_ABS = 5;
const THRESH_ROW_PCT = 0.05;
const THRESH_COMM_ABS_CENTS = 10_000; // $100
const THRESH_COMM_PCT = 0.05;

function todayCentral() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function postToSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const payload = JSON.stringify({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  const u = new URL(url);
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) { console.error('Missing GOOGLE_SHEET_ID'); process.exit(1); }

  const credentials = JSON.parse(await readFile(process.env.GOOGLE_CREDENTIALS_PATH, 'utf-8'));
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const today = todayCentral();
  console.log(`📅 Drift audit for ${today}`);

  // 1) Compute today's snapshot from the live Comissions tab
  const liveRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_NAME}!A:G` });
  const liveRows = (liveRes.data.values || []).slice(1);
  const snapshot = {}; // advertiser_id → { rows, sale, comm }
  for (const r of liveRows) {
    const id = r[1];
    if (!id) continue;
    snapshot[id] = snapshot[id] || { rows: 0, sale: 0, comm: 0 };
    snapshot[id].rows++;
    snapshot[id].sale += parseInt(r[5] || '0', 10);
    snapshot[id].comm += parseInt(r[6] || '0', 10);
  }
  console.log(`📊 Snapshotting ${Object.keys(snapshot).length} brands`);

  // 2) Make sure audit tab exists
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabExists = meta.data.sheets.some(s => s.properties.title === AUDIT_TAB);
  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: AUDIT_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${AUDIT_TAB}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [['snapshot_date', 'advertiser_id', 'row_count', 'sale_cents', 'commission_cents']] },
    });
    console.log('🆕 Created Drift Audit tab');
  }

  // 3) Read prior audit rows, get the most recent day before today
  const auditRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${AUDIT_TAB}!A:E` });
  const auditRows = (auditRes.data.values || []).slice(1);
  const priorByDay = {};
  for (const r of auditRows) {
    if (!r[0] || r[0] >= today) continue;
    priorByDay[r[0]] = priorByDay[r[0]] || {};
    priorByDay[r[0]][r[1]] = { rows: parseInt(r[2] || '0', 10), sale: parseInt(r[3] || '0', 10), comm: parseInt(r[4] || '0', 10) };
  }
  const priorDays = Object.keys(priorByDay).sort();
  const priorDay = priorDays[priorDays.length - 1] || null;
  const prior = priorDay ? priorByDay[priorDay] : null;

  // 4) Append today's snapshot (skip if today already recorded)
  const todayAlreadyWritten = auditRows.some(r => r[0] === today);
  if (!todayAlreadyWritten) {
    const newRows = Object.entries(snapshot).map(([id, s]) =>
      [today, id, String(s.rows), String(s.sale), String(s.comm)]
    );
    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${AUDIT_TAB}!A:E`, valueInputOption: 'RAW',
      requestBody: { values: newRows },
    });
    console.log(`✏️  Wrote ${newRows.length} snapshot rows for ${today}`);
  } else {
    console.log(`ℹ️  Snapshot for ${today} already exists, not re-writing`);
  }

  // 5) Compare to prior — alert on drops only
  if (!prior) {
    console.log('🌱 First audit run — no prior snapshot to compare against. Done.');
    return;
  }

  console.log(`🔍 Comparing today's state to ${priorDay} snapshot...`);
  const alerts = [];
  for (const [id, todayState] of Object.entries(snapshot)) {
    const priorState = prior[id];
    if (!priorState) continue; // brand wasn't tracked yesterday — first sighting

    const rowDrop = priorState.rows - todayState.rows;
    const commDrop = priorState.comm - todayState.comm;
    const rowPct = priorState.rows > 0 ? rowDrop / priorState.rows : 0;
    const commPct = priorState.comm > 0 ? commDrop / priorState.comm : 0;

    if (rowDrop >= THRESH_ROW_ABS && rowPct >= THRESH_ROW_PCT) {
      alerts.push(`• *${id}* row count: ${priorState.rows} → ${todayState.rows} (*-${rowDrop}*, -${(rowPct * 100).toFixed(1)}%)`);
    }
    if (commDrop >= THRESH_COMM_ABS_CENTS && commPct >= THRESH_COMM_PCT) {
      alerts.push(`• *${id}* commission: $${(priorState.comm / 100).toFixed(2)} → $${(todayState.comm / 100).toFixed(2)} (*-$${(commDrop / 100).toFixed(2)}*, -${(commPct * 100).toFixed(1)}%)`);
    }

    // Also: brand entirely disappeared (rows>0 yesterday, =0 today)
    if (priorState.rows > 0 && todayState.rows === 0) {
      alerts.push(`• *${id}* :rotating_light: brand DISAPPEARED entirely (${priorState.rows} rows → 0)`);
    }
  }
  // Brand-disappeared check from the other direction (in prior but not in today)
  for (const [id, priorState] of Object.entries(prior)) {
    if (!snapshot[id] && priorState.rows > 0) {
      alerts.push(`• *${id}* :rotating_light: brand DISAPPEARED entirely (${priorState.rows} rows → 0)`);
    }
  }

  if (alerts.length === 0) {
    console.log('✅ No drift detected. All brands stable within normal cancellation churn.');
    return;
  }

  const slackText = [
    ':chart_with_downwards_trend: *Drift Audit Alert*',
    `Sheet lost rows or commission for ${alerts.length} brand-metric${alerts.length === 1 ? '' : 's'} between ${priorDay} and ${today}.`,
    'Normal causes: refunds/cancellations at the source. Bug causes: a scraper bypassed the safety guard and over-deleted.',
    '',
    ...alerts,
    '',
    'Check the most recent scrape run logs if this looks unexpected.',
  ].join('\n');

  console.warn(slackText);
  await postToSlack(slackText);
  console.log(`📨 Alerted Slack about ${alerts.length} drift signal${alerts.length === 1 ? '' : 's'}`);
}

main().catch(e => {
  console.error('❌ Drift audit failed:', e.message);
  process.exit(1);
});
