import { launchBrowser, createStealthPage, sleep } from '@kitchen/shared/scraper-base';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = resolve(__dirname, '../.cookies');

export async function scrapeRefersionCommissions({ account, headless = true }) {
  console.log(`🚀 Starting Refersion scraper for ${account.advertiserName}...`);

  const cookiesPath = resolve(COOKIES_DIR, account.cookieFile);
  const savedCookies = await loadCookies(cookiesPath);

  if (!savedCookies) {
    throw new Error(`No cookies found at ${cookiesPath}. Export cookies from Chrome using Cookie-Editor.`);
  }

  let browser;
  try {
    browser = await launchBrowser({ headless });
  } catch (err) {
    console.error('❌ Failed to launch browser:', err.message);
    throw err;
  }

  const page = await createStealthPage(browser);

  try {
    console.log('🍪 Restoring session from cookies...');
    await page.setCookie(...savedCookies);

    console.log(`📍 Navigating to conversions page...`);
    await page.goto(account.conversionsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    const isAuthenticated = await checkAuthenticated(page);
    if (!isAuthenticated) {
      throw new Error('Session expired — cookies are no longer valid. Re-export cookies from Chrome.');
    }
    console.log('✅ Session valid');

    await saveCookies(page, cookiesPath);

    const screenshotPath = `refersion-${account.advertiserId}-dashboard.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 Screenshot saved: ${screenshotPath}`);

    const records = await extractConversions(page, account);
    console.log(`✅ Scraped ${records.length} conversions`);
    return records;

  } catch (err) {
    console.error('❌ Scraping failed:', err.message);
    const screenshotPath = `error-refersion-${account.advertiserId}-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`📸 Error screenshot: ${screenshotPath}`);
    throw err;
  } finally {
    await browser.close();
  }
}

async function extractConversions(page, account) {
  return await page.evaluate((advertiserId, advertiserName) => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const records = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 10) continue;

      // col 0: icon, col 1: conversion ID, col 2: subid, col 3: date,
      // col 4: platform, col 5: status, col 6: payment status,
      // col 7: total items, col 8: currency, col 9: order total, col 10: commission
      const conversionId = cells[1]?.innerText?.trim();
      const subId = cells[2]?.innerText?.trim() || '';
      const dateRaw = cells[3]?.innerText?.trim() || '';
      const status = cells[5]?.innerText?.trim()?.toLowerCase() || '';
      const currency = cells[8]?.innerText?.trim() || 'USD';
      const orderTotalRaw = cells[9]?.innerText?.trim() || '0';
      const commissionRaw = cells[10]?.innerText?.trim() || '0';

      if (!conversionId) continue;

      const parseAmount = str => {
        const num = parseFloat(str.replace(/[^0-9.-]/g, ''));
        return isNaN(num) ? 0 : Math.round(num * 100);
      };

      records.push({
        transaction_id: `refersion_${conversionId}`,
        advertiser_id: advertiserId,
        advertiser_name: advertiserName,
        order_date: dateRaw,
        currency_id: currency,
        sale_amount: parseAmount(orderTotalRaw),
        commission_amount: parseAmount(commissionRaw),
        status: status.includes('approved') ? 'approved' : status.includes('pending') ? 'pending' : status,
        sub_id_1: subId,
        order_ref: conversionId,
      });
    }

    return records;
  }, account.advertiserId, account.advertiserName);
}

async function checkAuthenticated(page) {
  const url = page.url();
  if (url.includes('login') || url.includes('sign_in')) return false;
  return await page.evaluate(() => {
    return !!document.querySelector('table') || /conversions found/i.test(document.body.innerText);
  });
}

async function loadCookies(cookiesPath) {
  try {
    const raw = await readFile(cookiesPath, 'utf-8');
    const cookies = JSON.parse(raw);
    const now = Date.now() / 1000;
    const valid = cookies.filter(c => !c.expires || c.expires > now);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

async function saveCookies(page, cookiesPath) {
  try {
    await mkdir(COOKIES_DIR, { recursive: true });
    const cookies = await page.cookies();
    await writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
  } catch (err) {
    console.warn('⚠️  Could not save cookies:', err.message);
  }
}
