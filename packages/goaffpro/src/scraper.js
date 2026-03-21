import {
  sleep,
  findSelector,
  launchBrowser,
  createStealthPage,
  setupNetworkInterception,
} from '@kitchen/shared/scraper-base';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = resolve(__dirname, '../.cookies');
const COOKIES_PATH = resolve(COOKIES_DIR, 'forwrd-cookies.json');

const LOGIN_URL = 'https://forwrd.goaffpro.com/login';
const DASHBOARD_URL = 'https://forwrd.goaffpro.com/';

/**
 * Scrapes the Details sales table from the GoAffPro (Forwrd) affiliate portal.
 *
 * Returns an empty array when the table shows "No Data". Returns the found
 * records when sales are present -- the caller decides how to handle that.
 *
 * Session cookies are persisted to `.cookies/forwrd-cookies.json` so
 * subsequent runs skip the login step.
 *
 * @param {Object} options
 * @param {string} options.email
 * @param {string} options.password
 * @param {boolean} [options.headless=true]
 * @returns {Promise<Array>} Raw sales records
 */
export async function scrapeCommissions({ email, password, headless = true }) {
  console.log('🚀 Starting GoAffPro (Forwrd) scraper...');
  console.log(`   Headless: ${headless}`);

  let browser;
  try {
    browser = await launchBrowser({ headless });
  } catch (err) {
    console.error('❌ Failed to launch browser:', err.message);
    throw err;
  }

  const page = await createStealthPage(browser);

  const apiResponses = [];

  await setupNetworkInterception(page, {
    onApiResponse: ({ url, data }) => {
      let records = null;

      if (data.data?.data && Array.isArray(data.data.data)) {
        records = data.data.data;
      } else if (Array.isArray(data.data)) {
        records = data.data;
      } else if (data.orders && Array.isArray(data.orders)) {
        records = data.orders;
      } else if (data.sales && Array.isArray(data.sales)) {
        records = data.sales;
      } else if (data.commissions && Array.isArray(data.commissions)) {
        records = data.commissions;
      } else if (data.conversions && Array.isArray(data.conversions)) {
        records = data.conversions;
      } else if (data.transactions && Array.isArray(data.transactions)) {
        records = data.transactions;
      } else if (Array.isArray(data)) {
        records = data;
      }

      const salesKeywords = ['order', 'sale', 'commission', 'conversion', 'transaction', 'earning', 'payout'];
      const looksLikeSalesEndpoint = salesKeywords.some(kw => url.toLowerCase().includes(kw));

      if (records && records.length > 0 && looksLikeSalesEndpoint) {
        console.log(`  └─ 💾 Captured ${records.length} records from ${url.split('?')[0]}`);
        apiResponses.push({ url, data, records });
      }
    },
  });

  try {
    // Attempt to reuse a saved session first
    const savedCookies = await loadCookies();

    if (savedCookies) {
      console.log('🍪 Found saved cookies, attempting to restore session...');
      await page.setCookie(...savedCookies);
      await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(2000);

      const isAuthenticated = await checkAuthenticated(page);
      if (!isAuthenticated) {
        console.log('   ⚠️  Session expired, logging in again...');
        await performLogin(page, email, password);
      } else {
        console.log('   ✅ Session restored from cookies!');
      }
    } else {
      console.log('🔐 No saved session, logging in...');
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await performLogin(page, email, password);
    }

    const postLoginAuth = await checkAuthenticated(page);
    if (!postLoginAuth) {
      throw new Error('Login failed -- not seeing authenticated dashboard after login');
    }

    console.log(`   Current URL: ${page.url()}`);
    await saveCookies(page);

    // Give the React app time to load the Details table
    console.log('⏳ Waiting for Details table to render...');
    await sleep(5000);

    // Scroll to trigger any lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1000);

    await page.screenshot({ path: 'goaffpro-dashboard.png', fullPage: true });
    console.log('   📸 Saved debug screenshot: goaffpro-dashboard.png');

    // Use intercepted API data when available
    let records = [];

    if (apiResponses.length > 0) {
      console.log(`\n📊 API responses captured: ${apiResponses.length}`);
      for (const { records: r } of apiResponses) {
        if (r && Array.isArray(r)) records.push(...r);
      }
      console.log(`✅ Using intercepted API data: ${records.length} records`);
    }

    // Fall back to DOM parsing
    if (records.length === 0) {
      console.log('📄 No API data captured, trying DOM parsing...');
      records = await extractFromDOM(page);
    }

    if (records.length === 0) {
      const isEmpty = await checkTableEmpty(page);
      if (isEmpty) {
        console.log('ℹ️  Details table shows "No Data" -- no sales yet.');
      } else {
        console.log('⚠️  Could not find any records; table state is unclear.');
        const pageInfo = await page.evaluate(() => ({
          title: document.title,
          bodyPreview: document.body.innerText.slice(0, 800),
          tableCount: document.querySelectorAll('table').length,
        }));
        console.log(`   Page title: ${pageInfo.title}`);
        console.log(`   Tables on page: ${pageInfo.tableCount}`);
        if (process.env.DEBUG) {
          console.log(`   Page text:\n${pageInfo.bodyPreview}`);
        }
      }
    }

    console.log(`\n✅ Scraped ${records.length} sales record(s)`);
    return records;

  } catch (err) {
    console.error('❌ Scraping failed:', err.message);
    const screenshotPath = `error-screenshot-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`📸 Error screenshot saved: ${screenshotPath}`);
    throw err;
  } finally {
    await browser.close();
  }
}

/**
 * Fills the login form and waits for the redirect to the dashboard.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} email
 * @param {string} password
 */
async function performLogin(page, email, password) {
  console.log('🔑 Filling login form...');

  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);

  // Fill email
  const emailSelector = await findSelector(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="mail" i]',
    'input[id*="email" i]',
  ]);
  if (!emailSelector) throw new Error('Could not find email input on login page');
  await page.click(emailSelector, { clickCount: 3 });
  await page.type(emailSelector, email, { delay: 40 });

  // Fill password
  const passwordSelector = await findSelector(page, [
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="password" i]',
    'input[id*="password" i]',
  ]);
  if (!passwordSelector) throw new Error('Could not find password input on login page');
  await page.click(passwordSelector, { clickCount: 3 });
  await page.type(passwordSelector, password, { delay: 40 });

  // Submit
  const submitSelector = await findSelector(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="login" i]',
    'button[class*="sign" i]',
  ]);

  if (submitSelector) {
    await page.click(submitSelector);
  } else {
    // Fallback: find a button with login/sign-in text
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const btn = buttons.find(el => /login|sign\s*in|log\s*in/i.test(el.textContent?.trim() || ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) throw new Error('Could not find login submit button');
  }

  console.log('   ⏳ Waiting for dashboard redirect...');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    sleep(15000),
  ]).catch(() => {});

  await sleep(2000);
  console.log(`   Redirected to: ${page.url()}`);
}

/**
 * Parses the Details table from the DOM.
 * Returns an array of row objects keyed by column header.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array>}
 */
async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const records = [];

    // GoAffPro renders a standard HTML table inside the Details section.
    // Try to find the most relevant table (one with order/sale/commission columns).
    const tables = Array.from(document.querySelectorAll('table'));
    if (tables.length === 0) return records;

    // Score each table by header relevance
    const salesKeywords = ['order', 'sale', 'commission', 'amount', 'status', 'date', 'affiliate'];
    const scored = tables.map(table => {
      const headerText = (table.querySelector('thead')?.innerText || '').toLowerCase();
      const score = salesKeywords.reduce((n, kw) => n + (headerText.includes(kw) ? 1 : 0), 0);
      return { table, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0].table;
    const headerCells = best.querySelectorAll('thead th, thead td');
    const headers = Array.from(headerCells).map(th =>
      th.textContent.trim().toLowerCase().replace(/\s+/g, '_')
    );

    const bodyRows = best.querySelectorAll('tbody tr');
    bodyRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length === 0) return;

      // Skip "No Data" placeholder rows
      if (cells.length === 1 && /no\s*data/i.test(cells[0].textContent)) return;

      const record = {};
      cells.forEach((cell, i) => {
        const key = headers[i] || `column_${i}`;
        record[key] = cell.textContent.trim();
      });
      records.push(record);
    });

    return records;
  });
}

/**
 * Returns true if the Details table contains a "No Data" placeholder row.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
async function checkTableEmpty(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    return /no\s*data/i.test(text) || /no\s*records/i.test(text) || /no\s*results/i.test(text);
  });
}

/**
 * Checks whether the page shows an authenticated dashboard rather than the
 * public landing page. The public page has "Join Now" CTAs and a Login button;
 * an authenticated session shows dashboard nav items or account elements.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
async function checkAuthenticated(page) {
  if (page.url().includes('login')) return false;

  const isPublicLanding = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return /join\s*now/i.test(text) && /how\s*does\s*it\s*work/i.test(text);
  });

  if (isPublicLanding) return false;

  const hasAuthElements = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return !!(
      document.querySelector('[class*="dashboard"], [class*="sidebar"], [class*="nav-menu"]') ||
      /my\s*account|dashboard|commission|earning|referral.*link/i.test(text)
    );
  });

  return hasAuthElements;
}

/**
 * Loads persisted cookies from disk. Returns null when the file is missing
 * or all cookies are expired.
 *
 * @returns {Promise<Array|null>}
 */
async function loadCookies() {
  try {
    const raw = await readFile(COOKIES_PATH, 'utf-8');
    const cookies = JSON.parse(raw);
    const now = Date.now() / 1000;
    const valid = cookies.filter(c => !c.expires || c.expires > now);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/**
 * Saves the current page cookies to disk for session reuse.
 *
 * @param {import('puppeteer').Page} page
 */
async function saveCookies(page) {
  try {
    await mkdir(COOKIES_DIR, { recursive: true });
    const cookies = await page.cookies();
    await writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log(`   ✅ Cookies saved to ${COOKIES_PATH}`);
  } catch (err) {
    console.warn('   ⚠️  Could not save cookies:', err.message);
  }
}
