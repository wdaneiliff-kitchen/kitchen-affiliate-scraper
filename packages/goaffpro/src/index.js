#!/usr/bin/env node

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import { scrapeCommissions } from './scraper.js';
import { createTransformer } from '@kitchen/shared/transformer';
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
 * Logs into the Forwrd affiliate portal, reads the Details sales table,
 * and exits based on what it finds:
 *
 *   - No records found  → exit 0  (expected while store has no sales yet)
 *   - Records found     → exit 1  (alerts the GitHub Action + Slack that
 *                                  sales data has appeared and needs review)
 *
 * Usage:
 *   pnpm goaffpro                  # Full run
 *   pnpm goaffpro:scrape           # Scrape only (outputs JSON, always exits 0)
 *   node src/index.js --visible    # Opens browser window for debugging
 *   node src/index.js --debug      # Verbose output
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GoAffPro (Forwrd) Scraper');
  console.log('═══════════════════════════════════════════════════════════\n');

  const args = process.argv.slice(2);
  const scrapeOnly = args.includes('--scrape-only');
  const headless = !args.includes('--visible');

  const config = validateConfig();

  try {
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

    // Sales have appeared -- transform and save so the data is inspectable
    if (rawRecords.length > 0 && process.env.DEBUG) {
      console.log('📋 Sample raw record fields:', Object.keys(rawRecords[0]).join(', '));
      console.log('📋 First raw record:', JSON.stringify(rawRecords[0], null, 2));
    }

    console.log('🔄 Transforming records...');
    const records = transformer.transformRecords(rawRecords);
    console.log(`   Transformed: ${records.length} record(s)`);

    const jsonPath = `goaffpro-sales-${new Date().toISOString().slice(0, 10)}.json`;
    await writeFile(jsonPath, JSON.stringify({ raw: rawRecords, transformed: records }, null, 2));
    console.log(`💾 Saved to: ${jsonPath}`);

    if (scrapeOnly) {
      console.log('\n✅ Scrape complete (--scrape-only mode). Exiting with 0.');
      process.exit(0);
    }

    // Exit 1 so the GitHub Action detects this as a notable event and fires Slack alert
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log(`║  ALERT: Found ${String(records.length).padEnd(3)} sales record(s) on GoAffPro (Forwrd)!  ║`);
    console.log('║  Review the JSON output and configure upload when ready.  ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(`\n  Records saved to: ${jsonPath}`);
    console.log('  To upload: implement the uploadToSheets call in index.js\n');
    process.exit(1);

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

function validateConfig() {
  const config = {
    email: process.env.GOAFFPRO_EMAIL,
    password: process.env.GOAFFPRO_PASSWORD,
  };

  const missing = [];
  if (!config.email) missing.push('GOAFFPRO_EMAIL');
  if (!config.password) missing.push('GOAFFPRO_PASSWORD');

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:\n');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\n📝 Add them to your .env file.');
    process.exit(1);
  }

  return config;
}

main();
