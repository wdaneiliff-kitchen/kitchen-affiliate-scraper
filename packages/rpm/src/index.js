#!/usr/bin/env node

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import { scrapeRPMStats } from './scraper.js';
import { appendDeltaRow, initRpmTab } from './sheets.js';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RPM Pickleball (Shopify Collabs) → Google Sheets');
  console.log('═══════════════════════════════════════════════════════════\n');

  const args = process.argv.slice(2);
  const scrapeOnly = args.includes('--scrape-only');
  const createSheet = args.includes('--create-sheet');
  const headless = !args.includes('--visible');

  const config = validateConfig({ scrapeOnly, createSheet });

  try {
    if (createSheet) {
      await initRpmTab({ credentialsPath: config.credentialsPath, spreadsheetId: config.spreadsheetId });
      console.log(`\n✅ "RPM Commissions" tab is ready in your Google Sheet.`);
      console.log(`   🔗 https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`);
      return;
    }

    console.log('📊 Scraping RPM Pickleball stats from Shopify Collabs...\n');
    const stats = await scrapeRPMStats({
      email: config.email,
      password: config.password,
      headless,
    });

    if (stats.sales === null || stats.earned === null) {
      console.error('❌ Could not extract Sales or Earned from the page.');
      if (stats.raw || stats.cardText) {
        console.log('📄 Page excerpt:', stats.raw || stats.cardText);
      }
      process.exit(1);
    }

    console.log(`\n📦 Current totals: Sales=${stats.sales}, Earned=$${stats.earned.toFixed(2)}`);

    if (scrapeOnly) {
      console.log('\n✅ Scrape complete (--scrape-only mode)');
      return;
    }

    console.log('\n📤 Uploading to Google Sheets...');
    const result = await appendDeltaRow({
      spreadsheetId: config.spreadsheetId,
      credentialsPath: config.credentialsPath,
      trackingSheetName: 'RPM Commissions',
      mainSheetName: 'Comissions',
      currentSales: stats.sales,
      currentEarned: stats.earned,
    });

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  ✅ Complete!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  📊 Total sales (cumulative):       ${stats.sales}`);
    console.log(`  💰 Total earned (cumulative):      $${stats.earned.toFixed(2)}`);
    if (result.isFirstRun) {
      console.log(`  ℹ️  First run — delta set to 0 (no previous data to compare)`);
    } else {
      console.log(`  🆕 New sales since last run:       ${result.newSales}`);
      console.log(`  🆕 New commissions since last run: $${result.newEarned.toFixed(2)}`);
    }
    console.log(`  🔗 Sheet: https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`);
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

function validateConfig({ scrapeOnly, createSheet }) {
  const config = {
    email: process.env.RPM_EMAIL,
    password: process.env.RPM_PASSWORD,
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || resolve(__dirname, '../../../credentials.json'),
  };

  const missing = [];

  if (!config.email) missing.push('RPM_EMAIL');
  if (!config.password) missing.push('RPM_PASSWORD');

  if (!scrapeOnly && !createSheet) {
    if (!config.spreadsheetId) missing.push('GOOGLE_SHEET_ID');
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
