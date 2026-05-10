#!/usr/bin/env node
/**
 * Date normalization tool for the main commissions sheet.
 *
 * Originally written as a one-shot UTC→Central migration in 2026-04. After
 * that migration ran, the script's semantics changed: it now normalizes any
 * row whose date columns do NOT match the canonical `YYYY-MM-DD HH:MM:SS`
 * Central-time format. Canonical rows are left alone.
 *
 * That makes it safe to re-run as a maintenance tool when legacy or
 * scraper-corrupted date strings show up (e.g. the May 2026 Refersion
 * leftovers and the "Joola" row).
 *
 * Trigger: `Migrate dates to Central time` workflow (workflow_dispatch only).
 */
import { google } from 'googleapis';
import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { formatDateCentral } from './transformer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SHEET_NAME = 'Comissions';
const DATE_COLS = [3, 8, 9, 10]; // order_date, click_date, validation_date, modified_date
// Same strict validation as transformer.js — rejects "24:MM:SS" and other malformed times.
const CANONICAL_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
// Specific repair for the May 2026 hour=24 bug: rewrite "YYYY-MM-DD 24:MM:SS" → "YYYY-MM-DD 00:MM:SS"
const HOUR_24_RE = /^(\d{4}-\d{2}-\d{2}) 24:(\d{2}:\d{2})$/;

async function main() {
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || resolve(__dirname, '../../../credentials.json');
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) { console.error('Missing GOOGLE_SHEET_ID'); process.exit(1); }

  const credentials = JSON.parse(await readFile(credentialsPath, 'utf-8'));
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  console.log('📖 Reading sheet...');
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_NAME}!A:V` });
  const rows = res.data.values || [];
  if (rows.length < 2) { console.log('No data rows found.'); return; }
  console.log(`📊 Found ${rows.length - 1} data rows. Looking for non-canonical date strings...`);

  const updates = [];
  let normalized = 0;
  let unparseable = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    for (const col of DATE_COLS) {
      const value = row[col];
      if (!value || CANONICAL_RE.test(value)) continue;
      // Quick repair for the hour=24 midnight bug — preserve the existing day.
      const hour24 = value.match(HOUR_24_RE);
      const fixed = hour24 ? `${hour24[1]} 00:${hour24[2]}` : formatDateCentral(value);
      if (!fixed) {
        console.warn(`  ⚠️  Row ${i + 1} col ${String.fromCharCode(65 + col)}: could not parse "${value}" — skipped`);
        unparseable++;
        continue;
      }
      updates.push({ range: `${SHEET_NAME}!${String.fromCharCode(65 + col)}${i + 1}`, values: [[fixed]] });
      console.log(`  ✏️  Row ${i + 1} col ${String.fromCharCode(65 + col)}: "${value}" → "${fixed}"`);
      normalized++;
    }
  }

  if (normalized === 0) {
    console.log('✅ All date columns already canonical. Nothing to do.');
    return;
  }

  console.log(`\n✏️  Applying ${normalized} normalizations...`);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
  console.log(`✅ Done. Normalized ${normalized} cells. ${unparseable ? `(${unparseable} were unparseable and left as-is.)` : ''}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
