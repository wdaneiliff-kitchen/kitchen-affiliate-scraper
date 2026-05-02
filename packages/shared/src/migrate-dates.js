#!/usr/bin/env node
import { google } from 'googleapis';
import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const SHEET_NAME = 'Comissions';
const DATE_COLS = [3, 8, 9, 10];

function utcStringToCentral(str) {
  if (!str || !str.trim()) return str;
  const date = new Date(str.trim().replace(' ', 'T') + 'Z');
  if (isNaN(date.getTime())) return str;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

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
  console.log(`📊 Found ${rows.length - 1} data rows. Converting dates...`);

  let changed = 0;
  const updatedRows = rows.map((row, i) => {
    if (i === 0) return row;
    const newRow = [...row];
    for (const col of DATE_COLS) {
      const converted = utcStringToCentral(row[col]);
      if (converted !== row[col]) { newRow[col] = converted; changed++; }
    }
    return newRow;
  });

  if (changed === 0) { console.log('✅ No dates needed conversion.'); return; }
  console.log(`✏️  Updating ${changed} date values...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW', requestBody: { values: updatedRows },
  });
  console.log(`✅ Done! Converted ${changed} date values to Central time.`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
