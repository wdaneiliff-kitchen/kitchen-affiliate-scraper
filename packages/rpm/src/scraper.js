import {
  sleep,
  launchBrowser,
  createStealthPage,
} from '@kitchen/shared/scraper-base';
import { Solver } from '@2captcha/captcha-solver';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = resolve(__dirname, '../.cookies');
const COOKIES_PATH = resolve(COOKIES_DIR, 'rpm-cookies.json');

const COLLABS_LANDING = 'https://www.shopify.com/collabs/creators';
const COLLABS_DASHBOARD = 'https://collabs.shopify.com/home';
const COLLABS_ANALYTICS = 'https://collabs.shopify.com/analytics';
const SHOPIFY_HCAPTCHA_SITEKEY = 'cceb8ca4-854a-4a77-a355-1480a3a79274';

export async function scrapeRPMStats({ email, password, headless = true }) {
  console.log('🚀 Starting RPM Pickleball (Shopify Collabs) scraper...');
  console.log(`   Headless: ${headless}`);

  let browser;
  try {
    browser = await launchBrowser({ headless });
  } catch (err) {
    console.error('❌ Failed to launch browser:', err.message);
    throw err;
  }

  const page = await createStealthPage(browser);

  try {
    const savedCookies = await loadCookies();

    if (savedCookies) {
      console.log('🍪 Found saved cookies, attempting to restore session...');
      await page.setCookie(...savedCookies);
      await page.goto(COLLABS_DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(3000);

      const isAuthenticated = await checkAuthenticated(page);
      if (!isAuthenticated) {
        console.log('   ⚠️  Session expired, logging in again...');
        await performLogin(page, email, password);
      } else {
        console.log('   ✅ Session restored from cookies!');
      }
    } else {
      console.log('🔐 No saved session, logging in...');
      await performLogin(page, email, password);
    }

    const postLoginAuth = await checkAuthenticated(page);
    if (!postLoginAuth) {
      throw new Error('Login failed — not seeing authenticated dashboard after login');
    }

    await saveCookies(page);

    // Navigate to Analytics page which has cumulative Sales and Earned totals
    console.log('📈 Navigating to Analytics page...');
    await page.goto(COLLABS_ANALYTICS, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4000);

    await page.screenshot({ path: 'rpm-dashboard.png', fullPage: true });
    console.log('   📸 Saved debug screenshot: rpm-dashboard.png');

    const stats = await extractRPMStats(page);
    console.log(`✅ Scraped: Sales=${stats.sales}, Earned=$${stats.earned}`);
    return stats;

  } catch (err) {
    console.error('❌ Scraping failed:', err.message);
    const screenshotPath = `error-screenshot-rpm-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`📸 Error screenshot saved: ${screenshotPath}`);
    throw err;
  } finally {
    await browser.close();
  }
}

async function performLogin(page, email, password) {
  const captchaKey = process.env.TWOCAPTCHA_API_KEY;

  // Step 1: Land on Collabs and click "LOG IN"
  console.log('🔑 Navigating to Shopify Collabs...');
  await page.goto(COLLABS_LANDING, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(3000);

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('a, button')).find(el => /^log\s*in$/i.test(el.textContent?.trim()));
    if (btn) btn.click();
  });
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
    sleep(8000),
  ]).catch(() => {});
  await sleep(2000);
  console.log(`   Lookup page: ${page.url()}`);

  // Step 2: Email lookup step (accounts.shopify.com/lookup)
  await page.waitForSelector('input[name="account[email]"]', { visible: true, timeout: 15000 });
  await page.click('input[name="account[email]"]', { clickCount: 3 });
  await page.type('input[name="account[email]"]', email, { delay: 50 });
  console.log('   ✅ Entered email');

  // Solve hCaptcha for the email lookup step
  if (captchaKey) {
    console.log('   🤖 Solving hCaptcha via 2captcha (takes ~30s)...');
    const token = await solveHcaptcha(captchaKey, {
      websiteURL: page.url(),
      websiteKey: SHOPIFY_HCAPTCHA_SITEKEY,
    });
    if (token) {
      await page.evaluate((t) => {
        const field = document.querySelector('input[name="h-captcha-response"]');
        if (field) field.value = t;
      }, token);
      console.log('   ✅ hCaptcha token injected');
    } else {
      console.log('   ⚠️  hCaptcha solve failed');
    }
  }

  // Submit the email lookup form
  await page.evaluate(() => {
    const form = document.querySelector('form');
    if (form) form.submit();
  });

  // Wait for the password page (accounts.shopify.com/login)
  console.log('   ⏳ Waiting for password page...');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    sleep(15000),
  ]).catch(() => {});
  await sleep(2000);
  console.log(`   Password page: ${page.url()}`);

  // Step 3: Password step (accounts.shopify.com/login)
  const passwordField = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 }).catch(() => null);

  if (!passwordField) {
    // Take screenshot to debug
    await page.screenshot({ path: `error-screenshot-rpm-nopassword-${Date.now()}.png`, fullPage: true }).catch(() => {});
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 600));
    console.log('📄 Page content:', pageText);
    throw new Error('Password page did not appear after email submission');
  }

  await page.click('input[type="password"]', { clickCount: 3 });
  await page.type('input[type="password"]', password, { delay: 50 });
  console.log('   ✅ Entered password');

  // Submit password form (no captcha on password step)
  await page.evaluate(() => {
    const form = document.querySelector('form');
    if (form) form.submit();
  });

  console.log('   ⏳ Waiting for redirect to dashboard...');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    sleep(15000),
  ]).catch(() => {});

  await sleep(3000);
  console.log(`   Redirected to: ${page.url()}`);
}

async function solveHcaptcha(apiKey, { websiteURL, websiteKey }) {
  try {
    const solver = new Solver(apiKey, 5000);
    const result = await solver.hcaptcha({ pageurl: websiteURL, sitekey: websiteKey });
    return result?.data ?? null;
  } catch (err) {
    console.warn(`   2captcha hCaptcha error: ${err.message}`);
    return null;
  }
}

async function extractRPMStats(page) {
  return await page.evaluate(() => {
    const bodyText = document.body.innerText;

    // Find a leaf element whose text is exactly "RPM Pickleball"
    const allElements = Array.from(document.querySelectorAll('*'));
    const rpmElement = allElements.find(el =>
      el.children.length === 0 &&
      el.textContent.trim() === 'RPM Pickleball'
    );

    if (rpmElement) {
      let card = rpmElement;
      for (let i = 0; i < 6; i++) {
        if (!card.parentElement) break;
        card = card.parentElement;
        const text = card.innerText || '';
        if (/Sales/i.test(text) && /Earned/i.test(text)) break;
      }

      const cardText = card.innerText || '';
      const salesMatch = cardText.match(/Sales\s+(\d[\d,]*)/i);
      const earnedMatch = cardText.match(/Earned\s+\$([0-9,]+\.?\d*)/i);

      return {
        sales: salesMatch ? parseInt(salesMatch[1].replace(/,/g, ''), 10) : null,
        earned: earnedMatch ? parseFloat(earnedMatch[1].replace(/,/g, '')) : null,
        cardText,
      };
    }

    // Fallback: scan full page text
    const salesMatch = bodyText.match(/Sales\s+(\d[\d,]*)/i);
    const earnedMatch = bodyText.match(/Earned\s+\$([0-9,]+\.?\d*)\s*USD/i);

    return {
      sales: salesMatch ? parseInt(salesMatch[1].replace(/,/g, ''), 10) : null,
      earned: earnedMatch ? parseFloat(earnedMatch[1].replace(/,/g, '')) : null,
      raw: bodyText.slice(0, 800),
    };
  });
}

async function checkAuthenticated(page) {
  const url = page.url();
  if (url.includes('login') || url.includes('sign_in') || url.includes('accounts.shopify.com')) {
    return false;
  }
  // collabs.shopify.com/home is the authenticated dashboard
  if (url.includes('collabs.shopify.com')) {
    return true;
  }
  return await page.evaluate(() => {
    const text = document.body.innerText || '';
    return /earned|commission|visits|conversion/i.test(text);
  });
}

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
