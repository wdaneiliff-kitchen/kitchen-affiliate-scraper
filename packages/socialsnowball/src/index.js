#!/usr/bin/env node

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env from monorepo root
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });
import { scrapePayouts, debugPageStructure } from './scraper.js';
import { createTransformer } from '@kitchen/shared/transformer';
import { uploadToSheets, validateAccess, getServiceAccountEmail, createSpreadsheet } from '@kitchen/shared/sheets';
import { writeFile } from 'fs/promises';
import { FIELD_MAPPINGS, STATUS_MAPPINGS, getAccount, ACCOUNT_NAMES, DEFAULT_ACCOUNT, extractProductTitle, extractCommissionAmount, extractSaleAmount, extractCurrency } from './config.js';

/**
 * Creates a transformer for a specific account
 */
function createAccountTransformer(account) {
  return createTransformer({
    fieldMappings: FIELD_MAPPINGS,
    statusMappings: STATUS_MAPPINGS,
    advertiserId: account.advertiserId,
    advertiserName: account.advertiserName,
    extractProductTitle,
  });
}

/**
 * SocialSnowball Scraper - Main Entry Point
 *
 * Scrapes payout data from SocialSnowball affiliate dashboard and uploads to Google Sheets.
 *
 * Usage:
 *   node src/index.js --account=enhance --scrape-only   # Scrape Enhance Pickleball
 *   node src/index.js --account=crbn --scrape-only      # Scrape CRBN
 *   node src/index.js --account=friday --scrape-only    # Scrape Friday
 *   node src/index.js --account=all --scrape-only       # Scrape ALL accounts
 *   node src/index.js --account=all                     # Scrape + upload ALL accounts
 *   node src/index.js --account=enhance                 # Scrape + upload
 *   node src/index.js --debug                           # Debug mode
 */

async function main() {
  const args = process.argv.slice(2);

  // Parse --account=name argument
  const accountArg = args.find(a => a.startsWith('--account='));
  const accountName = accountArg ? accountArg.split('=')[1] : DEFAULT_ACCOUNT;

  // Handle --account=all to process all accounts
  if (accountName === 'all') {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SocialSnowball Payout Scraper → Google Sheets');
    console.log('  Processing ALL accounts');
    console.log('═══════════════════════════════════════════════════════════\n');

    const results = [];
    for (const name of ACCOUNT_NAMES) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  Processing: ${name.toUpperCase()}`);
      console.log(`${'─'.repeat(60)}\n`);

      try {
        const result = await processAccount(name, args);
        results.push({ account: name, success: true, ...result });
      } catch (error) {
        console.error(`\n❌ Error processing ${name}: ${error.message}`);
        results.push({ account: name, success: false, error: error.message });
      }
    }

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  Summary - All Accounts');
    console.log('═══════════════════════════════════════════════════════════');
    for (const r of results) {
      const status = r.success ? '✅' : '❌';
      const details = r.success ? `${r.records || 0} records` : r.error;
      console.log(`  ${status} ${r.account.padEnd(12)} ${details}`);
    }
    console.log('═══════════════════════════════════════════════════════════\n');
    return;
  }

  const account = getAccount(accountName);
  if (!account) {
    console.error(`❌ Unknown account: ${accountName}`);
    console.error(`   Available accounts: ${ACCOUNT_NAMES.join(', ')}, all`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  SocialSnowball Payout Scraper → Google Sheets`);
  console.log(`  Account: ${account.advertiserName}`);
  console.log('═══xw════════════════════════════════════════════════════════\n');

  await processAccount(accountName, args);
}

/**
 * Process a single account
 */
async function processAccount(accountName, args) {
  const account = getAccount(accountName);

  const scrapeOnly = args.includes('--scrape-only');
  const uploadOnly = args.includes('--upload-only');
  const debugMode = args.includes('--debug');
  const createSheet = args.includes('--create-sheet');
  const headless = !args.includes('--visible');

  const config = validateConfig({ scrapeOnly, uploadOnly, createSheet, account });

  if (debugMode) {
    console.log('🔍 Debug mode - opening browser for inspection...\n');
    await debugPageStructure({
      email: config.email,
      password: config.password,
    });
    return { records: 0 };
  }

  if (createSheet) {
    const spreadsheetId = await createSpreadsheet({
      credentialsPath: config.credentialsPath,
      title: 'SocialSnowball Payouts',
    });

    const serviceEmail = await getServiceAccountEmail(config.credentialsPath);
    console.log('\n📋 Next steps:');
    console.log(`   1. Open: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
    console.log(`   2. The sheet is owned by: ${serviceEmail}`);
    console.log(`   3. Share it with your personal Google account if needed`);
    console.log(`   4. Update GOOGLE_SHEET_ID in your .env file: ${spreadsheetId}`);
    return { records: 0 };
  }

  if (!scrapeOnly) {
    console.log('🔐 Validating Google Sheets access...');
    const hasAccess = await validateAccess({
      credentialsPath: config.credentialsPath,
      spreadsheetId: config.spreadsheetId,
    });

    if (!hasAccess) {
      const serviceEmail = await getServiceAccountEmail(config.credentialsPath);
      console.log(`\n💡 To fix: Share your Google Sheet with: ${serviceEmail}`);
      throw new Error('No access to Google Sheet');
    }
    console.log('');
  }

  let records;

  if (!uploadOnly) {
    console.log(`📊 Scraping SocialSnowball payouts for ${account.advertiserName}...\n`);

    const rawPayouts = await scrapePayouts({
      email: config.email,
      password: config.password,
      merchantName: account.merchantName,
      headless,
    });

    console.log(`\n📦 Raw records scraped: ${rawPayouts.length}`);

    // Debug: show raw data structure
    if (rawPayouts.length > 0) {
      console.log('📋 Sample raw record fields:', Object.keys(rawPayouts[0]).join(', '));
      if (process.env.DEBUG) {
        console.log('📋 First raw record:', JSON.stringify(rawPayouts[0], null, 2));
      }
    }

    // Pre-process records to flatten nested amount fields
    const processedPayouts = rawPayouts.map(record => ({
      ...record,
      // Flatten nested amount fields for the transformer
      _commission_amount: extractCommissionAmount(record),
      _sale_amount: extractSaleAmount(record),
      _currency: extractCurrency(record),
    }));

    console.log('🔄 Transforming data to target schema...');
    const transformer = createAccountTransformer(account);
    records = transformer.transformRecords(processedPayouts);
    console.log(`✅ Transformed records: ${records.length}\n`);

    const jsonPath = `socialsnowball-${accountName}-payouts-${new Date().toISOString().slice(0, 10)}.json`;
    await writeFile(jsonPath, JSON.stringify({ raw: rawPayouts, transformed: records }, null, 2));
    console.log(`💾 Saved to: ${jsonPath}\n`);

    if (scrapeOnly) {
      console.log('✅ Scrape complete (--scrape-only mode)');
      return { records: records.length };
    }
  } else {
    console.log('📂 Upload-only mode - looking for recent JSON file...');
    console.log('⚠️  Upload-only mode requires implementing JSON file loading');
    console.log('    For now, run without --upload-only to scrape and upload together');
    throw new Error('Upload-only mode not implemented');
  }

  console.log('📤 Uploading to Google Sheets...\n');
  const result = await uploadToSheets({
    spreadsheetId: config.spreadsheetId,
    credentialsPath: config.credentialsPath,
    records,
    sheetName: config.sheetName,
    clearFirst: args.includes('--clear'),
    dedupeByTransactionId: !args.includes('--no-dedupe'),
  });

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✅ Complete!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  📊 Total records:    ${result.total}`);
  console.log(`  ✅ Uploaded:         ${result.uploaded}`);
  console.log(`  ⏭️  Skipped (dupes):  ${result.skipped}`);
  console.log(`  🔗 Sheet: https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  return { records: records.length, uploaded: result.uploaded, skipped: result.skipped };
}

function validateConfig({ scrapeOnly, uploadOnly, createSheet, account }) {
  const config = {
    email: account.email,
    password: account.password,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || resolve(__dirname, '../../../credentials.json'),
    sheetName: process.env.SHEET_NAME || 'Commissions',
  };

  const missing = [];

  if (!uploadOnly && !createSheet) {
    if (!config.email) missing.push(`SOCIALSNOWBALL_${account.advertiserId.toUpperCase()}_EMAIL`);
    if (!config.password) missing.push(`SOCIALSNOWBALL_${account.advertiserId.toUpperCase()}_PASSWORD`);
  }

  if (!scrapeOnly) {
    if (!config.spreadsheetId && !createSheet) missing.push('GOOGLE_SHEET_ID');
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:\n');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\n📝 Create a .env file with the required values.');
    console.error('   Example:');
    console.error('   SOCIALSNOWBALL_EMAIL=your-email@example.com');
    console.error('   SOCIALSNOWBALL_PASSWORD=your-password');
    console.error('   GOOGLE_SHEET_ID=your-spreadsheet-id\n');
    process.exit(1);
  }

  return config;
}

main().catch(error => {
  console.error('\n❌ Error:', error.message);
  if (process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});

