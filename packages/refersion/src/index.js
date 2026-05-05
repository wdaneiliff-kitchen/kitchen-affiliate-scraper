#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from monorepo root
try {
  const envFile = await readFile(resolve(__dirname, '../../../.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)/);
    if (match) process.env[match[1].trim()] ||= match[2].trim();
  }
} catch {}

import { scrapeRefersionCommissions } from './scraper.js';
import { uploadToSheets, validateAccess } from '@kitchen/shared/sheets';
import { ACCOUNTS, ACCOUNT_NAMES } from './config.js';

const MAIN_HEADERS = [
  'transaction_id', 'advertiser_id', 'advertiser_name', 'order_date', 'currency_id',
  'sale_amount', 'commission_amount', 'status', 'click_date', 'validation_date',
  'modified_date', 'sub_id_1', 'sub_id_2', 'sub_id_3', 'sub_id_4', 'sub_id_5',
  'sub_id_6', 'decline_reason', 'paid_to_publisher', 'clickout_url', 'product_title', 'order_ref',
];

async function main() {
  const args = process.argv.slice(2);
  const scrapeOnly = args.includes('--scrape-only');
  const headless = !args.includes('--visible');
  const accountArg = args.find(a => a.startsWith('--account='));
  const accountName = accountArg ? accountArg.split('=')[1] : 'all';

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || resolve(__dirname, '../../../credentials.json');
  const sheetName = 'Comissions';

  const accountsToRun = accountName === 'all'
    ? ACCOUNT_NAMES.filter(n => {
        // Skip accounts with no cookie file check — they'll fail gracefully
        return true;
      })
    : [accountName];

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Refersion Commission Scraper → Google Sheets');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!scrapeOnly) {
    console.log('🔐 Validating Google Sheets access...');
    const hasAccess = await validateAccess({ credentialsPath, spreadsheetId });
    if (!hasAccess) throw new Error('No access to Google Sheet');
    console.log('✅ Sheet access confirmed\n');
  }

  const results = [];

  for (const name of accountsToRun) {
    const account = ACCOUNTS[name];
    if (!account) {
      console.warn(`⚠️  Unknown account: ${name}`);
      continue;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  Processing: ${name.toUpperCase()}`);
    console.log(`${'─'.repeat(60)}\n`);

    try {
      const records = await scrapeRefersionCommissions({ account, headless });

      if (scrapeOnly) {
        console.log(`✅ Scrape-only: ${records.length} records`);
        results.push({ account: name, success: true, records: records.length });
        continue;
      }

      console.log(`\n📤 Uploading ${records.length} records to Google Sheets...`);
      const result = await uploadToSheets({
        spreadsheetId,
        credentialsPath,
        records,
        sheetName,
        dedupeByTransactionId: true,
      });

      console.log(`  ✅ ${name.padEnd(10)} ${result.uploaded} new, ${result.skipped} dupes`);
      results.push({ account: name, success: true, records: records.length, uploaded: result.uploaded });
    } catch (err) {
      console.error(`\n❌ ${name}: ${err.message}`);
      results.push({ account: name, success: false, error: err.message });
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════');
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    const detail = r.success ? `${r.records} records` : r.error;
    console.log(`  ${status} ${r.account.padEnd(12)} ${detail}`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
