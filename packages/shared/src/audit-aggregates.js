// Helpers for the "Audit Aggregates" sheet tab. Scrapers call writeAuditAggregate
// after a successful scrape to persist each brand's platform-reported lifetime
// total (paid + outstanding commission). The nightly accuracy-audit job reads
// these rows and compares them against the sum of the Comissions tab to detect
// silent data-loss bugs in the scraper (the kind that caused the 2026-05-12
// SocialSnowball Paid-tab incident).
import { google } from 'googleapis';
import { readFile } from 'fs/promises';

const AGGREGATES_TAB = 'Audit Aggregates';
const HEADERS = [
  'advertiser_id',
  'platform',
  'lifetime_paid_usd',
  'lifetime_outstanding_usd',
  'lifetime_total_usd',
  'lifetime_conversion_count',
  'captured_at',
];

async function getSheetsClient(credentialsPath) {
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf-8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function ensureTab(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some((s) => s.properties.title === AGGREGATES_TAB);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: AGGREGATES_TAB } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${AGGREGATES_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });
  console.log(`📊 Created tab: ${AGGREGATES_TAB}`);
}

function nowCentralIso() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  let hour = parts.hour;
  if (hour === '24') hour = '00';
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

/**
 * Upsert the brand's lifetime aggregate row in `Audit Aggregates`.
 * One row per advertiser_id; subsequent calls overwrite in place.
 */
export async function writeAuditAggregate({
  spreadsheetId,
  credentialsPath,
  advertiserId,
  platform,
  lifetimePaidUsd,
  lifetimeOutstandingUsd,
  lifetimeConversionCount,
}) {
  if (!spreadsheetId || !credentialsPath || !advertiserId || !platform) {
    throw new Error('writeAuditAggregate requires spreadsheetId, credentialsPath, advertiserId, platform');
  }
  const sheets = await getSheetsClient(credentialsPath);
  await ensureTab(sheets, spreadsheetId);

  const paid = Number(lifetimePaidUsd ?? 0);
  const outstanding = Number(lifetimeOutstandingUsd ?? 0);
  const total = paid + outstanding;
  const capturedAt = nowCentralIso();

  const row = [
    advertiserId,
    platform,
    paid.toFixed(2),
    outstanding.toFixed(2),
    total.toFixed(2),
    String(lifetimeConversionCount ?? ''),
    capturedAt,
  ];

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${AGGREGATES_TAB}!A:G`,
  });
  const existingRows = existing.data.values || [];
  let foundRow = -1;
  for (let i = 1; i < existingRows.length; i++) {
    if (existingRows[i][0] === advertiserId) {
      foundRow = i + 1; // 1-indexed sheet row
      break;
    }
  }

  if (foundRow > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${AGGREGATES_TAB}!A${foundRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    console.log(`📊 Audit aggregate updated: ${advertiserId} → paid $${paid.toFixed(2)} + outstanding $${outstanding.toFixed(2)} = $${total.toFixed(2)}`);
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${AGGREGATES_TAB}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    console.log(`📊 Audit aggregate inserted: ${advertiserId} → paid $${paid.toFixed(2)} + outstanding $${outstanding.toFixed(2)} = $${total.toFixed(2)}`);
  }
}
