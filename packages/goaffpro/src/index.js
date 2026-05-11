#!/usr/bin/env node

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import { scrapeCommissions } from './scraper.js';
import { createTransformer, filterValidCommissionRecords } from '@kitchen/shared/transformer';
import { reconcileToSheets, validateAccess, getServiceAccountEmail, createSpreadsheet } from '@kitchen/shared/sheets';
import { FIELD_MAPPINGS, STATUS_MAPPINGS, ADVERTISER_ID, ADVERTISER_NAME, extractProductTitle } from './config.js';

const transformer = createTransformer({
  fieldMappings: FIELD_MAPPINGS,
  statusMappings: STATUS_MAPPINGS,
  advertiserId: ADVERTISER_ID,
  advertiserName: ADVERTISER_NAME,
  extractProductTitle,
});

/**
 * GoAffPro (Forwrd) Scraper -- Main Entry Point
 *
 * Scrapes commission data from the Forwrd affiliate portal and uploads
 * to Google Sheets.
 *
 * Usage:
 *   pnpm goaffpro                  # Full run (scrape + upload)
 *   pnpm goaffpro:scrape           # Scrape only (outputs JSON, always exits 0)
 *   node src/index.js --visible    # Opens browser window for debugging
 *   node src/index.js --debug      # Verbose output
 *   node src/index.js --create-sheet  # Create a new Google Sheet with headers
 *   node src/index.js --clear      # Clear existing data before uploading
 *   node src/index.js --no-dedupe  # Skip transaction_id deduplication
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GoAffPro (Forwrd) Scraper → Google Sheets');
  console.log('═══════════════════════════════════════════════════════════\n');

  const args = process.argv.slice(2);
  const scrapeOnly = args.includes('--scrape-only');
  const uploadOnly = args.includes('--upload-only');
  const createSheet = args.includes('--create-sheet');
  const headless = !args.includes('--visible');

  const config = validateConfig({ scrapeOnly, uploadOnly, createSheet });

  try {
    if (createSheet) {
      const spreadsheetId = await createSpreadsheet({
        credentialsPath: config.credentialsPath,
        title: 'GoAffPro (Forwrd) Commissions',
      });

      const serviceEmail = await getServiceAccountEmail(config.credentialsPath);
      console.log('\n📋 Next steps:');
      console.log(`   1. Open: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
      console.log(`   2. The sheet is owned by: ${serviceEmail}`);
      console.log(`   3. Share it with your personal Google account if needed`);
      console.log(`   4. Update GOOGLE_SHEET_ID in your .env file: ${spreadsheetId}`);
      return;
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
        process.exit(1);
      }
      console.log('');
    }

    let records;

    if (!uploadOnly) {
      console.log('📊 Scraping GoAffPro (Forwrd) Details table...\n');

      const rawRecords = await scrapeCommissions({
        email: config.email,
        password: config.password,
        headless,
      });

      console.log(`\n📦 Raw records found: ${rawRecords.length}`);

      if (rawRecords.length === 0) {
        console.log('\n✅ Details table is empty -- no sales data yet. Nothing to do.');
        console.log('═══════════════════════════════════════════════════════════\n');
        process.exit(0);
      }

      if (rawRecords.length > 0 && process.env.DEBUG) {
        console.log('📋 Sample raw record fields:', Object.keys(rawRecords[0]).join(', '));
        console.log('📋 First raw record:', JSON.stringify(rawRecords[0], null, 2));
      }

      console.log('🔄 Transforming records...');
      const transformed = transformer.transformRecords(rawRecords);
      records = filterValidCommissionRecords(transformed);
      const invalidCount = transformed.length - records.length;
      if (invalidCount > 0) {
        console.log(`⚠️ Filtered out ${invalidCount} invalid records (missing order_date or zero amounts)`);
      }
      console.log(`✅ Valid commission records: ${records.length}\n`);

      const jsonPath = `goaffpro-sales-${new Date().toISOString().slice(0, 10)}.json`;
      await writeFile(jsonPath, JSON.stringify({ raw: rawRecords, transformed: records }, null, 2));
      console.log(`💾 Saved to: ${jsonPath}\n`);

      if (scrapeOnly) {
        console.log('✅ Scrape complete (--scrape-only mode)');
        return;
      }
    } else {
      console.log('📂 Upload-only mode - looking for recent JSON file...');
      console.log('⚠️  Upload-only mode requires implementing JSON file loading');
      console.log('    For now, run without --upload-only to scrape and upload together');
      process.exit(1);
    }

    console.log('📤 Reconciling with Google Sheets...\n');
    const result = await reconcileToSheets({
      spreadsheetId: config.spreadsheetId,
      credentialsPath: config.credentialsPath,
      records,
      advertiserId: ADVERTISER_ID,
      sheetName: config.sheetName,
    });

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ✅ Complete!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  📥 Inserted:        ${result.inserted}`);
    console.log(`  🔄 Updated:         ${result.updated}`);
    console.log(`  🗑️  Deleted (ghost): ${result.deleted}${result.deleteAborted ? ' (DELETES ABORTED BY SAFETY GUARD)' : ''}`);
    console.log(`  🔗 Sheet: https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`);
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

function validateConfig({ scrapeOnly, uploadOnly, createSheet }) {
  const config = {
    email: process.env.GOAFFPRO_EMAIL,
    password: process.env.GOAFFPRO_PASSWORD,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || resolve(__dirname, '../../../credentials.json'),
    sheetName: process.env.SHEET_NAME || 'Comissions',
  };

  const missing = [];

  if (!uploadOnly && !createSheet) {
    if (!config.email) missing.push('GOAFFPRO_EMAIL');
    if (!config.password) missing.push('GOAFFPRO_PASSWORD');
  }

  if (!scrapeOnly) {
    if (!config.spreadsheetId && !createSheet) missing.push('GOOGLE_SHEET_ID');
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:\n');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\n📝 Add them to your .env file.');
    process.exit(1);
  }

  return config;
}

main();
