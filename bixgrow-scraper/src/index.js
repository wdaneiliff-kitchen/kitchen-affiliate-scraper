#!/usr/bin/env node

import 'dotenv/config';
import { scrapeCommissions, debugPageStructure } from './scraper.js';
import { transformRecords, toSheetRows } from './transformer.js';
import { uploadToSheets, validateAccess, getServiceAccountEmail, createSpreadsheet } from './sheets.js';
import { writeFile } from 'fs/promises';

/**
 * BixGrow Scraper - Main Entry Point
 *
 * Scrapes commission data from BixGrow affiliate dashboard and uploads to Google Sheets.
 *
 * Usage:
 *   npm start                    # Full scrape + transform + upload
 *   npm run scrape               # Scrape only (outputs to JSON file)
 *   node src/index.js --debug    # Debug mode (opens browser for inspection)
 *   node src/index.js --create-sheet  # Create a new Google Sheet with headers
 */

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BixGrow Commission Scraper → Google Sheets');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  const scrapeOnly = args.includes('--scrape-only');
  const uploadOnly = args.includes('--upload-only');
  const debugMode = args.includes('--debug');
  const createSheet = args.includes('--create-sheet');
  const headless = !args.includes('--visible');

  // Validate environment variables
  const config = validateConfig({ scrapeOnly, uploadOnly, createSheet });

  try {
    // Debug mode - open browser for manual inspection
    if (debugMode) {
      console.log('🔍 Debug mode - opening browser for inspection...\n');
      await debugPageStructure({
        email: config.email,
        password: config.password,
      });
      return;
    }

    // Create new spreadsheet
    if (createSheet) {
      const spreadsheetId = await createSpreadsheet({
        credentialsPath: config.credentialsPath,
        title: 'BixGrow Commissions',
      });

      const serviceEmail = await getServiceAccountEmail(config.credentialsPath);
      console.log('\n📋 Next steps:');
      console.log(`   1. Open: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
      console.log(`   2. The sheet is owned by: ${serviceEmail}`);
      console.log(`   3. Share it with your personal Google account if needed`);
      console.log(`   4. Update GOOGLE_SHEET_ID in your .env file: ${spreadsheetId}`);
      return;
    }

    // Validate Google Sheets access (unless scrape-only)
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

    // Scrape data (unless upload-only)
    if (!uploadOnly) {
      console.log('📊 Scraping BixGrow commissions...\n');

      const rawCommissions = await scrapeCommissions({
        email: config.email,
        password: config.password,
        headless,
        startDate: config.startDate,
        endDate: config.endDate,
      });

      console.log(`\n📦 Raw records scraped: ${rawCommissions.length}`);

      // Transform data
      console.log('🔄 Transforming data to target schema...');
      records = transformRecords(rawCommissions);
      console.log(`✅ Transformed records: ${records.length}\n`);

      // Save to JSON for debugging/backup
      const jsonPath = `commissions-${new Date().toISOString().slice(0, 10)}.json`;
      await writeFile(jsonPath, JSON.stringify(records, null, 2));
      console.log(`💾 Saved to: ${jsonPath}\n`);

      if (scrapeOnly) {
        console.log('✅ Scrape complete (--scrape-only mode)');
        return;
      }
    } else {
      // Upload-only mode - load from most recent JSON file
      console.log('📂 Upload-only mode - looking for recent JSON file...');
      // For upload-only, user should specify a file or we could find the most recent
      console.log('⚠️  Upload-only mode requires implementing JSON file loading');
      console.log('    For now, run without --upload-only to scrape and upload together');
      process.exit(1);
    }

    // Upload to Google Sheets
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

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Validates required environment variables
 */
function validateConfig({ scrapeOnly, uploadOnly, createSheet }) {
  const config = {
    email: process.env.BIXGROW_EMAIL,
    password: process.env.BIXGROW_PASSWORD,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json',
    sheetName: process.env.SHEET_NAME || 'Commissions',
    startDate: process.env.START_DATE,
    endDate: process.env.END_DATE,
  };

  const missing = [];

  // BixGrow credentials required for scraping
  if (!uploadOnly && !createSheet) {
    if (!config.email) missing.push('BIXGROW_EMAIL');
    if (!config.password) missing.push('BIXGROW_PASSWORD');
  }

  // Google Sheets config required for uploading or creating sheet
  if (!scrapeOnly) {
    if (!config.spreadsheetId && !createSheet) missing.push('GOOGLE_SHEET_ID');
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:\n');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\n📝 Copy .env.example to .env and fill in the values.');
    console.error('   See README.md for setup instructions.\n');
    process.exit(1);
  }

  return config;
}

// Run
main();

