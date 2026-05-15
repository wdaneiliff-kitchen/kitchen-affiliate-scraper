#!/usr/bin/env node

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Load .env from monorepo root
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });
import { scrapeCommissions, debugPageStructure } from './scraper.js';
import { createTransformer } from '@kitchen/shared/transformer';
import { reconcileToSheets, validateAccess, getServiceAccountEmail, createSpreadsheet } from '@kitchen/shared/sheets';
import { writeAuditAggregate } from '@kitchen/shared/audit-aggregates';
import { writeFile, readFile, readdir } from 'fs/promises';
import { FIELD_MAPPINGS, STATUS_MAPPINGS, getAccount, ACCOUNT_NAMES, DEFAULT_ACCOUNT, extractProductTitle } from './config.js';

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
 * UpPromote Scraper - Main Entry Point
 *
 * Scrapes commission data from UpPromote affiliate dashboard and uploads to Google Sheets.
 *
 * Usage:
 *   node src/index.js --account=luzz --scrape-only      # Scrape Luzz
 *   node src/index.js --account=honolulu --scrape-only  # Scrape Honolulu
 *   node src/index.js --account=holbrook --scrape-only  # Scrape Holbrook
 *   node src/index.js --account=all --scrape-only       # Scrape ALL accounts
 *   node src/index.js --account=all                     # Scrape + upload ALL accounts
 *   node src/index.js --account=luzz                    # Scrape + upload Luzz
 *   node src/index.js --debug --account=luzz            # Debug mode
 */

async function main() {
  const args = process.argv.slice(2);

  // Parse --account=name argument
  const accountArg = args.find(a => a.startsWith('--account='));
  const accountName = accountArg ? accountArg.split('=')[1] : DEFAULT_ACCOUNT;

  // Handle --account=all to process all accounts
  if (accountName === 'all') {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  UpPromote Commission Scraper → Google Sheets');
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
  console.log(`  UpPromote Commission Scraper → Google Sheets`);
  console.log(`  Account: ${account.advertiserName}`);
  console.log('═══════════════════════════════════════════════════════════\n');

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

  const config = validateConfig({ scrapeOnly, uploadOnly, createSheet, account, accountName });

  if (debugMode) {
    console.log('🔍 Debug mode - opening browser for inspection...\n');
    await debugPageStructure({
      email: config.email,
      password: config.password,
      baseUrl: config.baseUrl,
    });
    return { records: 0 };
  }

  if (createSheet) {
    const spreadsheetId = await createSpreadsheet({
      credentialsPath: config.credentialsPath,
      title: `UpPromote Commissions - ${account.advertiserName}`,
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
  let platformTotalCount = null;

  if (!uploadOnly) {
    console.log(`📊 Scraping UpPromote commissions for ${account.advertiserName}...\n`);

    const rawCommissions = await scrapeCommissions({
      email: config.email,
      password: config.password,
      baseUrl: config.baseUrl,
      accountId: accountName,
      headless,
      startDate: config.startDate,
      endDate: config.endDate,
      twoCaptchaKey: config.twoCaptchaKey,
    });

    console.log(`\n📦 Raw records scraped: ${rawCommissions.length}`);
    if (rawCommissions._platformTotal != null) {
      platformTotalCount = rawCommissions._platformTotal;
    }

    // Debug: show raw data structure
    if (rawCommissions.length > 0) {
      console.log('📋 Sample raw record fields:', Object.keys(rawCommissions[0]).join(', '));
      if (process.env.DEBUG) {
        console.log('📋 First raw record:', JSON.stringify(rawCommissions[0], null, 2));
      }
    }

    console.log('🔄 Transforming data to target schema...');
    const transformer = createAccountTransformer(account);
    records = transformer.transformRecords(rawCommissions);

    if (account.commissionRate) {
      let overrideCount = 0;
      records = records.map(r => {
        if (r.commission_amount === 0 && r.sale_amount !== 0) {
          overrideCount++;
          return { ...r, commission_amount: Math.round(r.sale_amount * account.commissionRate) };
        }
        return r;
      });
      if (overrideCount > 0) {
        console.log(`💱 Applied ${(account.commissionRate * 100).toFixed(0)}% commission override to ${overrideCount} records`);
      }
    }

    console.log(`✅ Transformed records: ${records.length}\n`);

    const jsonPath = `uppromote-${accountName}-commissions-${new Date().toISOString().slice(0, 10)}.json`;
    await writeFile(jsonPath, JSON.stringify({ raw: rawCommissions, transformed: records }, null, 2));
    console.log(`💾 Saved to: ${jsonPath}\n`);

    if (scrapeOnly) {
      console.log('✅ Scrape complete (--scrape-only mode)');
      return { records: records.length };
    }
  } else {
    // --upload-only mode: load from existing JSON file
    const fileArg = args.find(a => a.startsWith('--file='));
    let jsonPath;

    if (fileArg) {
      jsonPath = fileArg.split('=')[1];
    } else {
      // Find the most recent JSON file for this account
      console.log(`📂 Looking for recent JSON file for ${accountName}...`);
      const rootDir = resolve(__dirname, '../../..');
      const files = await readdir(rootDir);
      const matchingFiles = files
        .filter(f => f.startsWith(`uppromote-${accountName}-commissions-`) && f.endsWith('.json'))
        .sort()
        .reverse();

      if (matchingFiles.length === 0) {
        throw new Error(`No JSON files found matching uppromote-${accountName}-commissions-*.json in project root`);
      }

      jsonPath = resolve(rootDir, matchingFiles[0]);
      console.log(`📄 Found: ${matchingFiles[0]}`);
    }

    console.log(`📂 Loading data from: ${jsonPath}`);
    const fileData = JSON.parse(await readFile(jsonPath, 'utf-8'));

    if (fileData.transformed && fileData.transformed.length > 0) {
      // Use pre-transformed data
      records = fileData.transformed;
      console.log(`✅ Loaded ${records.length} pre-transformed records`);
    } else if (fileData.raw && fileData.raw.length > 0) {
      // Re-transform from raw data
      console.log(`🔄 Transforming ${fileData.raw.length} raw records...`);
      const transformer = createAccountTransformer(account);
      records = transformer.transformRecords(fileData.raw);
      console.log(`✅ Transformed ${records.length} records`);
    } else {
      throw new Error('JSON file has no raw or transformed data');
    }
  }

  console.log('📤 Reconciling with Google Sheets...\n');
  const result = await reconcileToSheets({
    spreadsheetId: config.spreadsheetId,
    credentialsPath: config.credentialsPath,
    records,
    advertiserId: account.advertiserId,
    sheetName: config.sheetName,
  });

  // Persist the platform-reported total row count for the nightly accuracy
  // audit. UpPromote shows this as "Showing N–M of TOTAL" on each brand's
  // commissions page; the scraper captures it via getPaginationInfo and
  // attaches it to the records array as a non-enumerable property.
  if (Number.isFinite(platformTotalCount) && platformTotalCount > 0) {
    try {
      await writeAuditAggregate({
        spreadsheetId: config.spreadsheetId,
        credentialsPath: config.credentialsPath,
        advertiserId: account.advertiserId,
        platform: 'uppromote',
        lifetimeConversionCount: platformTotalCount,
      });
    } catch (err) {
      console.log(`⚠️ Failed to write audit aggregate for ${account.advertiserId}: ${err.message}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✅ Complete!');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  📥 Inserted:        ${result.inserted}`);
  console.log(`  🔄 Updated:         ${result.updated}`);
  console.log(`  🗑️  Deleted (ghost): ${result.deleted}${result.deleteAborted ? ' (DELETES ABORTED BY SAFETY GUARD)' : ''}`);
  console.log(`  🔗 Sheet: https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  return { records: records.length, inserted: result.inserted, updated: result.updated, deleted: result.deleted };
}

function validateConfig({ scrapeOnly, uploadOnly, createSheet, account, accountName }) {
  const config = {
    email: account.email,
    password: account.password,
    baseUrl: account.baseUrl,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || resolve(__dirname, '../../../credentials.json'),
    sheetName: process.env.SHEET_NAME || 'Comissions',
    startDate: process.env.START_DATE,
    endDate: process.env.END_DATE,
    twoCaptchaKey: process.env.TWOCAPTCHA_API_KEY,  // Optional: for auto-solving CAPTCHA
  };

  const missing = [];
  const envPrefix = `UPPROMOTE_${accountName.toUpperCase()}`;

  if (!uploadOnly && !createSheet) {
    if (!config.email) missing.push(`${envPrefix}_EMAIL`);
    if (!config.password) missing.push(`${envPrefix}_PASSWORD`);
    if (!config.baseUrl) missing.push(`${envPrefix}_BASE_URL`);
  }

  if (!scrapeOnly) {
    if (!config.spreadsheetId && !createSheet) missing.push('GOOGLE_SHEET_ID');
  }

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:\n');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\n📝 Create a .env file in the monorepo root with:');
    console.error(`   ${envPrefix}_EMAIL=your-email@example.com`);
    console.error(`   ${envPrefix}_PASSWORD=your-password`);
    console.error(`   ${envPrefix}_BASE_URL=https://af.uppromote.com/your-shop-id`);
    console.error('\n   See packages/uppromote/README.md for setup instructions.\n');
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
