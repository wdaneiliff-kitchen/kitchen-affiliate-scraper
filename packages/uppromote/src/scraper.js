import {
  sleep,
  findSelector,
  launchBrowser,
  createStealthPage,
  setupNetworkInterception,
  getCookieString,
} from '@kitchen/shared/scraper-base';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { solveRecaptchaV2 } from './twocaptcha.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = resolve(__dirname, '../.cookies');

/**
 * Gets the cookie file path for an account
 */
function getCookiePath(accountId) {
  return resolve(COOKIES_DIR, `${accountId}-cookies.json`);
}

/**
 * Saves cookies to file for reuse
 */
async function saveCookies(page, accountId) {
  try {
    await mkdir(COOKIES_DIR, { recursive: true });
    const cookies = await page.cookies();
    await writeFile(getCookiePath(accountId), JSON.stringify(cookies, null, 2));
    console.log(`   💾 Saved session cookies for future runs`);
  } catch (e) {
    console.warn(`   ⚠️ Could not save cookies: ${e.message}`);
  }
}

/**
 * Loads cookies from file
 */
async function loadCookies(page, accountId) {
  try {
    const cookieData = await readFile(getCookiePath(accountId), 'utf-8');
    const cookies = JSON.parse(cookieData);
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`   🍪 Loaded saved session cookies`);
      return true;
    }
  } catch (e) {
    // No saved cookies or invalid file
  }
  return false;
}

/**
 * Scrapes commission data from UpPromote affiliate dashboard.
 * Uses network interception to capture API responses for cleaner data extraction.
 *
 * @param {Object} options - Scraper options
 * @param {string} options.email - UpPromote login email
 * @param {string} options.password - UpPromote login password
 * @param {string} options.baseUrl - Base URL (e.g., https://af.uppromote.com/010661-db)
 * @param {string} options.accountId - Account identifier for cookie storage
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @param {string} [options.startDate] - Filter start date (YYYY-MM-DD)
 * @param {string} [options.endDate] - Filter end date (YYYY-MM-DD)
 * @param {string} [options.twoCaptchaKey] - Optional 2captcha API key for auto-solving
 * @returns {Promise<Array>} Array of commission/transaction objects
 */
export async function scrapeCommissions({
  email,
  password,
  baseUrl,
  accountId = 'default',
  headless = true,
  startDate,
  endDate,
  twoCaptchaKey,
}) {
  console.log('🚀 Starting UpPromote scraper...');
  console.log(`   Base URL: ${baseUrl}`);
  console.log(`   Account: ${accountId}`);
  console.log(`   Headless: ${headless}`);

  const LOGIN_URL = `${baseUrl}/commission`;
  const COMMISSIONS_URL = `${baseUrl}/commission`;

  let browser;
  try {
    console.log('🌐 Launching browser...');
    browser = await launchBrowser({ headless });
  } catch (launchError) {
    console.error('❌ Failed to launch browser:', launchError.message);
    throw launchError;
  }

  const page = await createStealthPage(browser);

  // Store intercepted API responses and auth token
  const apiResponses = [];
  const allJsonResponses = [];  // Log ALL JSON responses for diagnostics
  let authToken = null;

  // Set up network interception to capture commission data from API calls
  await setupNetworkInterception(page, {
    onApiResponse: ({ url, data }) => {
      // Log ALL JSON responses for diagnostics
      const urlPath = url.split('?')[0];
      const preview = JSON.stringify(data).slice(0, 200);
      console.log(`  📡 JSON: ${urlPath}`);
      console.log(`     Preview: ${preview}...`);
      allJsonResponses.push({ url, data, timestamp: Date.now() });

      // Capture auth token from login response
      if (data.token || data.access_token || data.accessToken) {
        authToken = data.token || data.access_token || data.accessToken;
        console.log(`  └─ 🔑 Captured auth token`);
      }

      // Extract records from various response structures
      let records = null;

      // UpPromote might use different response structures
      if (data.data?.data && Array.isArray(data.data.data)) {
        records = data.data.data;  // Nested: { data: { data: [...] } }
      } else if (Array.isArray(data.data)) {
        records = data.data;  // Direct: { data: [...] }
      } else if (data.commissions && Array.isArray(data.commissions)) {
        records = data.commissions;
      } else if (data.referrals && Array.isArray(data.referrals)) {
        records = data.referrals;
      } else if (data.conversions && Array.isArray(data.conversions)) {
        records = data.conversions;
      } else if (Array.isArray(data)) {
        records = data;
      }

      // Capture responses that look like commission/conversion data
      const urlLower = url.toLowerCase();
      const isCommissionEndpoint =
        urlLower.includes('commission') ||
        urlLower.includes('referral') ||
        urlLower.includes('conversion') ||
        urlLower.includes('order');

      // Exclude non-data endpoints
      const isExcluded =
        urlLower.includes('notification') ||
        urlLower.includes('login') ||
        urlLower.includes('logout') ||
        urlLower.includes('setting');

      if (records && records.length > 0 && isCommissionEndpoint && !isExcluded) {
        console.log(`  └─ 💾 CAPTURED: ${records.length} records from ${urlPath}`);
        apiResponses.push({ url, data, records });
      }
    },
  });

  try {
    // Try to load saved cookies first
    const hasSavedCookies = await loadCookies(page, accountId);

    // Step 1: Navigate to commission page
    console.log('📍 Navigating to UpPromote...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for either the login form or the commissions table to appear
    console.log('   Waiting for page content...');
    await page.waitForSelector('input[type="password"], table, .commission, [class*="commission"]', {
      timeout: 30000,
    }).catch(() => {});
    await sleep(2000);

    // Check if we're on a login page (cookies might have expired)
    const isLoginPage = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasLoginForm = document.querySelector('input[type="password"]') !== null;
      return hasLoginForm || text.includes('login') || text.includes('sign in');
    });

    if (isLoginPage) {
      if (hasSavedCookies) {
        console.log('   ⚠️ Saved cookies expired, need to login again');
        // Clear stale cookies to avoid CSRF token mismatch with the fresh page.
        // Laravel sessions embed a CSRF token in the cookie; stale values cause
        // silent 419 (Page Expired) rejections on form submit.
        const client = await page.createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.detach();
        console.log('   🗑️ Cleared stale cookies');
        // Reload to get a fresh CSRF token
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('input[type="password"]', { timeout: 15000 }).catch(() => {});
        await sleep(1000);
      }
      console.log('🔐 Login required, entering credentials...');

      // Wait for login form to render
      await page.waitForSelector('input[type="email"], input[type="text"], input[placeholder*="email" i], input[name="email"]', {
        timeout: 15000
      });

      // Find and fill email field
      const emailSelector = await findSelector(page, [
        'input[type="email"]',
        'input[name="email"]',
        'input[placeholder*="email" i]',
        'input[id*="email" i]',
        'input[type="text"]',  // Some forms use text type
      ]);

      const passwordSelector = await findSelector(page, [
        'input[type="password"]',
        'input[name="password"]',
        'input[placeholder*="password" i]',
        'input[id*="password" i]',
      ]);

      if (!emailSelector || !passwordSelector) {
        throw new Error('Could not find login form fields');
      }

      await page.type(emailSelector, email, { delay: 50 });
      await page.type(passwordSelector, password, { delay: 50 });

      // Check for reCAPTCHA
      const hasCaptcha = await page.evaluate(() => {
        return document.querySelector('iframe[src*="recaptcha"]') !== null ||
               document.querySelector('.g-recaptcha') !== null ||
               document.querySelector('[class*="recaptcha"]') !== null ||
               document.body.innerText.toLowerCase().includes('recaptcha') ||
               document.body.innerText.includes("I'm not a robot");
      });

      let captchaSolveAttempts = 0;
      if (hasCaptcha) {
        // Try 2captcha if API key provided
        if (twoCaptchaKey) {
          console.log('\n🤖 reCAPTCHA detected - attempting auto-solve with 2captcha...');
          const solved = await solve2Captcha(page, twoCaptchaKey);
          captchaSolveAttempts++;
          if (!solved) {
            console.log('   ⚠️ Auto-solve failed, falling back to manual...');
          }
        }

        // When 2captcha is available, let the retry logic below re-solve if the
        // first token was rejected. The reCAPTCHA widget text ("I'm not a robot")
        // stays in the DOM even after injecting a solved token, so checking it here
        // gives false positives that would throw before retries can run.
        if (!twoCaptchaKey) {
          throw new Error('CAPTCHA detected but no TWOCAPTCHA_API_KEY configured. Cannot solve in CI.');
        }
      } else {
        // No CAPTCHA, proceed with normal login
        console.log('🔑 Submitting login...');
        await submitLogin(page);
      }

      // Ensure we submit in CAPTCHA flows where callback handling did not auto-submit.
      const stateAfterCaptcha = await getLoginState(page);
      if (stateAfterCaptcha.onLoginPage) {
        // When CAPTCHA was solved via 2captcha, re-solve rather than doing a bare
        // submit — the previous token may have been consumed/rejected and the fresh
        // page requires a new one. A bare submit without a token just wastes an
        // attempt and may trigger rate limiting.
        if (twoCaptchaKey && captchaSolveAttempts > 0) {
          console.log(`   🔁 Still on login page after CAPTCHA solve, re-solving (attempt ${captchaSolveAttempts + 1})...`);
          await solve2Captcha(page, twoCaptchaKey);
          captchaSolveAttempts++;
        } else {
          console.log('🔑 Submitting login...');
          await submitLogin(page);
        }
      }

      // Retry a few times for slow auth/captcha verification.
      for (let attempt = 1; attempt <= 3; attempt++) {
        const loginState = await getLoginState(page);
        if (!loginState.onLoginPage) {
          break;
        }

        // Always re-solve captcha when still on login page and we have a key.
        // The page may not show explicit "reCAPTCHA required" text even though the
        // previous token was rejected or expired. A fresh solve is the safest bet.
        if (twoCaptchaKey && captchaSolveAttempts < 4) {
          console.log(`   🔁 Still on login page, re-solving CAPTCHA (attempt ${captchaSolveAttempts + 1})...`);
          await solve2Captcha(page, twoCaptchaKey);
          captchaSolveAttempts++;
        } else {
          console.log(`   🔁 Login still pending, retrying submit (${attempt}/3)...`);
          await submitLogin(page);
        }
      }

      const finalLoginState = await getLoginState(page);
      if (finalLoginState.onLoginPage) {
        if (finalLoginState.hasInvalidCredentials) {
          throw new Error('Login failed - invalid credentials');
        }
        if (finalLoginState.hasCaptchaRequired) {
          throw new Error('Login failed - CAPTCHA still required after auto-solve');
        }
        if (finalLoginState.hasTooManyAttempts) {
          throw new Error('Login failed - too many attempts, please try later');
        }
        throw new Error(`Login failed - still on login page (${page.url()})`);
      }

      // Save cookies after successful login for future runs
      await saveCookies(page, accountId);

      console.log(`   ✅ Login successful! Cookies saved for future runs.`);
    } else {
      console.log('   ✅ Already logged in (using saved session)');
    }

    // Ensure we're on the commissions page
    const currentUrl = page.url();
    if (!currentUrl.includes('/commission')) {
      console.log('📊 Navigating to commissions page...');
      await page.goto(COMMISSIONS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('table, .commission, [class*="commission"]', { timeout: 30000 }).catch(() => {});
    }

    // Detect 404 / error pages before spending time on data extraction.
    // Some UpPromote custom domains drop routes without warning.
    const pageTitle = await page.title();
    if (pageTitle === '404' || pageTitle.toLowerCase().includes('not found')) {
      const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 300));
      throw new Error(
        `Commission page returned 404 (${page.url()}). ` +
        `The UpPromote route may have changed — verify the base URL in config.\n` +
        `   Page text: ${bodySnippet.slice(0, 150)}`
      );
    }

    // Wait for the page to load data
    console.log('⏳ Waiting for page data to load...');
    await sleep(5000);

    console.log(`   Current URL: ${page.url()}`);

    // Try scrolling to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    // ── Diagnostic dump: log page structure ──────────────────────────────
    try {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  🔍 DIAGNOSTIC: Page & Network Analysis');
    console.log('══════════════════════════════════════════════════════════');

    // 1. All JSON responses seen so far
    console.log(`\n📡 Total JSON responses intercepted: ${allJsonResponses.length}`);
    for (const { url, data } of allJsonResponses) {
      try {
        const shortUrl = url.split('?')[0].replace(/https?:\/\/[^/]+/, '');
        const queryStr = url.includes('?') ? '?' + url.split('?')[1].slice(0, 80) : '';
        const topKeys = typeof data === 'object' && data !== null ? Object.keys(data).join(', ') : typeof data;
        let recordCount = '';
        if (data?.data?.data && Array.isArray(data.data.data)) recordCount = ` (data.data.data: ${data.data.data.length} items)`;
        else if (Array.isArray(data?.data)) recordCount = ` (data.data: ${data.data.length} items)`;
        else if (Array.isArray(data)) recordCount = ` (array: ${data.length} items)`;
        console.log(`   ${shortUrl}${queryStr}`);
        console.log(`     Keys: [${topKeys}]${recordCount}`);

        // Log pagination metadata if present
        const meta = data?.data || data;
        if (meta?.total || meta?.last_page || meta?.per_page) {
          console.log(`     📄 Pagination: total=${meta.total}, per_page=${meta.per_page}, current_page=${meta.current_page}, last_page=${meta.last_page}`);
        }

        // Log first record structure if we find records
        const records = data?.data?.data || (Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : null));
        if (records && records.length > 0 && typeof records[0] === 'object') {
          console.log(`     📋 First record keys: [${Object.keys(records[0]).join(', ')}]`);
          console.log(`     📋 First record sample: ${JSON.stringify(records[0]).slice(0, 500)}`);
        }
      } catch (e) {
        console.log(`   [error logging response: ${e.message}] url=${url?.slice(0, 100)}`);
      }
    }

    // 2. DOM table structure
    const domDiag = await page.evaluate(() => {
      const result = { tables: [], pagination: null, bodyTextSnippet: '' };

      // Inspect all tables
      const tables = document.querySelectorAll('table');
      tables.forEach((table, i) => {
        const headers = [];
        table.querySelectorAll('thead th, thead td').forEach(th => headers.push(th.textContent.trim()));
        const rowCount = table.querySelectorAll('tbody tr').length;

        // Sample first row
        const firstRow = table.querySelector('tbody tr');
        const firstRowCells = [];
        if (firstRow) {
          firstRow.querySelectorAll('td').forEach(td => {
            firstRowCells.push(td.textContent.trim().slice(0, 60));
          });
        }

        result.tables.push({ index: i, headers, rowCount, firstRowCells });
      });

      // Look for pagination info
      const pagText = document.body.innerText.match(/showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i);
      if (pagText) {
        result.pagination = pagText[0];
      }

      // Look for "entries" text
      const entriesText = document.body.innerText.match(/\d+\s+entries/i);
      if (entriesText) {
        result.entriesText = entriesText[0];
      }

      // Page text snippet for context
      result.bodyTextSnippet = document.body.innerText.slice(0, 800);

      return result;
    });

    console.log(`\n📊 DOM Tables found: ${domDiag.tables.length}`);
    for (const t of domDiag.tables) {
      console.log(`   Table ${t.index}: ${t.rowCount} rows`);
      console.log(`     Headers: [${t.headers.join(' | ')}]`);
      if (t.firstRowCells.length > 0) {
        console.log(`     First row: [${t.firstRowCells.join(' | ')}]`);
      }
    }

    if (domDiag.pagination) {
      console.log(`\n📄 Pagination text: "${domDiag.pagination}"`);
    }
    if (domDiag.entriesText) {
      console.log(`   Entries text: "${domDiag.entriesText}"`);
    }

    // 3. Check for any XHR/fetch cookies or auth headers we can reuse
    const cookies = await page.cookies();
    const authCookies = cookies.filter(c =>
      c.name.toLowerCase().includes('token') ||
      c.name.toLowerCase().includes('session') ||
      c.name.toLowerCase().includes('auth') ||
      c.name.toLowerCase().includes('laravel')
    );
    console.log(`\n🍪 Relevant cookies: ${authCookies.map(c => `${c.name}=${c.value.slice(0, 20)}...`).join(', ') || 'none'}`);

    // 4. Check localStorage for tokens
    const storageTokens = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      const relevant = keys.filter(k =>
        k.toLowerCase().includes('token') ||
        k.toLowerCase().includes('auth') ||
        k.toLowerCase().includes('session')
      );
      return relevant.map(k => ({ key: k, value: (localStorage.getItem(k) || '').slice(0, 40) }));
    });
    if (storageTokens.length > 0) {
      console.log(`🔑 localStorage tokens: ${storageTokens.map(t => `${t.key}=${t.value}...`).join(', ')}`);
    }

    // Save full diagnostic to file
    const diagData = {
      url: page.url(),
      allJsonResponses: allJsonResponses.map(r => ({
        url: r.url,
        dataKeys: Object.keys(r.data),
        dataPreview: JSON.stringify(r.data).slice(0, 2000),
      })),
      domDiag,
      authCookies: authCookies.map(c => ({ name: c.name, value: c.value.slice(0, 40) })),
      storageTokens,
      capturedCommissionResponses: apiResponses.length,
      authToken: authToken ? `${authToken.slice(0, 20)}...` : null,
    };
    const diagPath = `uppromote-diagnostic-${Date.now()}.json`;
    await writeFile(diagPath, JSON.stringify(diagData, null, 2));
    console.log(`\n💾 Full diagnostic saved to: ${diagPath}`);
    console.log('══════════════════════════════════════════════════════════\n');
    } catch (diagError) {
      console.warn(`⚠️ Diagnostic logging failed (non-fatal): ${diagError.message}`);
      console.warn(diagError.stack);
    }
    // ── End diagnostic dump ──────────────────────────────────────────────

    // Step 5: Apply date filters if provided
    if (startDate || endDate) {
      console.log(`📅 Applying date filter: ${startDate || 'start'} to ${endDate || 'end'}`);
      await applyDateFilter(page, startDate, endDate);
    }

    // Step 6: Extract data
    let commissions = [];

    console.log(`\n📊 API responses captured: ${apiResponses.length}`);

    if (apiResponses.length > 0) {
      console.log('✅ Using intercepted API data');
      commissions = extractFromApiResponses(apiResponses);
    }

    // Get auth token from localStorage/cookies if not captured
    if (!authToken) {
      authToken = await page.evaluate(() => {
        return localStorage.getItem('token') ||
               localStorage.getItem('auth_token') ||
               localStorage.getItem('access_token') ||
               sessionStorage.getItem('token');
      });
    }

    // Try to fetch all pages via direct API calls or DOM pagination
    console.log('\n📄 Fetching all pages of commission data...');
    const allCommissions = await fetchAllCommissions(page, baseUrl, authToken, apiResponses);
    if (allCommissions.length > 0) {
      commissions = allCommissions;
    }

    // Fall back to DOM parsing if no API data
    if (commissions.length === 0) {
      console.log('📄 Trying DOM parsing...');
      commissions = await extractFromDOM(page);

      if (commissions.length === 0) {
        console.log('⚠️ No data found. Taking debug screenshot...');
        await page.screenshot({ path: 'debug-uppromote-page.png', fullPage: true });
        console.log(`   Current URL: ${page.url()}`);
        console.log(`   Page title: ${await page.title()}`);

        // Log page structure for debugging
        const pageInfo = await page.evaluate(() => {
          const tables = document.querySelectorAll('table');
          return {
            tableCount: tables.length,
            bodyText: document.body.innerText.slice(0, 1000),
          };
        });
        console.log(`   Tables found: ${pageInfo.tableCount}`);
        console.log(`   Page text preview:\n${pageInfo.bodyText.slice(0, 500)}...`);
      }
    }

    // Update cookies after successful scrape (extends session)
    await saveCookies(page, accountId);

    console.log(`✅ Scraped ${commissions.length} commission records`);

    return commissions;

  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
    const screenshotPath = `error-screenshot-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 Error screenshot saved to: ${screenshotPath}`);
    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Injects a solved reCAPTCHA token into the page and invokes the registered callback.
 *
 * reCAPTCHA v2 requires two things for the site to accept the solution:
 *  1. The token must be set in the hidden g-recaptcha-response textarea
 *  2. The site's registered callback function must be called with the token
 *
 * The callback can live in several places:
 *  - data-callback attribute on the .g-recaptcha widget element
 *  - ___grecaptcha_cfg.clients[widgetId] internal config (nested object walk)
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string} token - Solved reCAPTCHA token
 * @returns {Promise<boolean>} True if a callback was found and invoked
 */
async function injectRecaptchaToken(page, token) {
  return await page.evaluate((t) => {
    // 1. Set all g-recaptcha-response textareas (usually one, but be safe)
    const textareas = document.querySelectorAll(
      '#g-recaptcha-response, textarea[name="g-recaptcha-response"], textarea[id^="g-recaptcha-response"]'
    );
    textareas.forEach((el) => {
      el.value = t;
      el.innerHTML = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    // 2. Patch grecaptcha so AJAX form submissions pick up the token.
    //    Many Laravel/JS apps call grecaptcha.getResponse() rather than reading the
    //    textarea directly — if we only set the textarea the server gets an empty token.
    //    Some forms use invisible reCAPTCHA and call grecaptcha.execute() instead,
    //    which returns a Promise; patch that too so the resolved value is our token.
    try {
      if (window.grecaptcha) {
        window.grecaptcha.getResponse = function () { return t; };
        window.grecaptcha.execute = function () { return Promise.resolve(t); };
        if (window.grecaptcha.enterprise) {
          window.grecaptcha.enterprise.getResponse = function () { return t; };
          window.grecaptcha.enterprise.execute = function () { return Promise.resolve(t); };
        }
      }
    } catch (_) { /* ignore if frozen */ }

    // 3. Try data-callback attribute on the widget element
    const widget = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (widget) {
      const callbackName = widget.getAttribute('data-callback');
      if (callbackName && typeof window[callbackName] === 'function') {
        window[callbackName](t);
        return true;
      }
    }

    // 4. Walk ___grecaptcha_cfg.clients to find the callback
    try {
      const clients = window.___grecaptcha_cfg?.clients;
      if (clients) {
        for (const clientId of Object.keys(clients)) {
          const client = clients[clientId];

          // Recursively search the client object for a callback function
          const findCallback = (obj, depth) => {
            if (depth > 6 || !obj || typeof obj !== 'object') return null;
            for (const key of Object.keys(obj)) {
              const val = obj[key];
              if (key === 'callback' && typeof val === 'function') return val;
              if (typeof val === 'object') {
                const found = findCallback(val, depth + 1);
                if (found) return found;
              }
            }
            return null;
          };

          const cb = findCallback(client, 0);
          if (cb) {
            cb(t);
            return true;
          }
        }
      }
    } catch (_) {
      // ignore errors walking internal config
    }

    // 5. Try common global callback names as last resort
    const globalNames = ['onRecaptchaSuccess', 'captchaCallback', 'onCaptchaSuccess', 'recaptchaCallback'];
    for (const name of globalNames) {
      if (typeof window[name] === 'function') {
        window[name](t);
        return true;
      }
    }

    return false;
  }, token);
}

/**
 * Solves reCAPTCHA using @2captcha/captcha-solver and injects token + submits login.
 * @returns {boolean} True if solved successfully
 */
async function solve2Captcha(page, apiKey) {
  try {
    const sitekey = await page.evaluate(() => {
      const el = document.querySelector('.g-recaptcha, [data-sitekey]');
      return el?.getAttribute('data-sitekey') || null;
    });

    if (!sitekey) {
      console.log('   Could not find reCAPTCHA sitekey');
      return false;
    }

    const websiteURL = page.url();
    console.log(`   📤 Sending CAPTCHA to 2captcha (sitekey: ${sitekey.slice(0, 20)}...)`);

    const token = await solveRecaptchaV2(apiKey, {
      websiteURL,
      websiteKey: sitekey,
    });

    if (!token) {
      return false;
    }

    console.log(`   ✅ Got CAPTCHA solution!`);

    const callbackInvoked = await injectRecaptchaToken(page, token);
    console.log(`   ${callbackInvoked ? '✅ Callback invoked' : '⚠️ No callback found, token set in textarea + getResponse() patched'}`);

    await sleep(500);

    // Try clicking the submit button (with waitForNavigation so we don't race ahead)
    const loginBtn = await findSelector(page, [
      'button[type="submit"]',
      'input[type="submit"]',
    ]);
    if (loginBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        safeClick(page, loginBtn),
      ]);
      await sleep(2000);
    }

    // Check if we navigated away from login
    const afterClickState = await page.evaluate(() => {
      return document.querySelector('input[type="password"]') !== null;
    });
    if (!afterClickState) {
      console.log('   ✅ Login submit succeeded after CAPTCHA solve');
      return true;
    }

    // Still on login page — try form.submit() as fallback.
    // Some forms use JS that reads grecaptcha.getResponse() — the patched version
    // returns our token, but the button click may have triggered an AJAX handler
    // that ran before our patch took effect. Native form.submit() includes the
    // g-recaptcha-response textarea value directly.
    console.log('   🔁 Button click did not navigate, trying form.submit()...');
    const formSubmitted = await page.evaluate(() => {
      const form = document.querySelector('form');
      if (form) { form.submit(); return true; }
      return false;
    });

    if (formSubmitted) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(2000);
    }

    const afterSubmitState = await page.evaluate(() => {
      return document.querySelector('input[type="password"]') !== null;
    });
    if (!afterSubmitState) {
      console.log('   ✅ form.submit() succeeded after CAPTCHA solve');
    } else {
      console.log('   ⚠️ Still on login page after CAPTCHA solve + form submit');
    }

    return true;
  } catch (error) {
    console.log(`   ❌ 2captcha error: ${error.message}`);
    return false;
  }
}

/**
 * Reads login page state after a submit attempt.
 */
async function getLoginState(page) {
  return page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    const hasPasswordField = document.querySelector('input[type="password"]') !== null;
    const hasEmailField =
      document.querySelector('input[type="email"], input[name="email"]') !== null;
    const onLoginPage = hasPasswordField && hasEmailField;

    return {
      onLoginPage,
      hasInvalidCredentials:
        text.includes('invalid') ||
        text.includes('incorrect') ||
        text.includes('wrong password') ||
        text.includes('email or password is incorrect'),
      hasCaptchaRequired:
        text.includes('recaptcha is required') ||
        text.includes("i'm not a robot") ||
        text.includes('please verify you are human'),
      hasTooManyAttempts:
        text.includes('too many attempts') ||
        text.includes('try again later'),
    };
  });
}

/**
 * Clicks the login button (or Enter key fallback) and waits briefly.
 */
async function submitLogin(page) {
  const loginButtonSelector = await findSelector(page, [
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'input[type="submit"]',
  ]);

  if (loginButtonSelector) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      safeClick(page, loginButtonSelector),
    ]);
  } else {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      page.keyboard.press('Enter'),
    ]);
  }

  await sleep(3000);
}

/**
 * Click helper that tolerates detached/covered login buttons.
 */
async function safeClick(page, selector) {
  try {
    await page.waitForSelector(selector, { visible: true, timeout: 5000 });
  } catch (_) {
    // Continue and try best-effort click strategies below.
  }

  try {
    await page.click(selector, { delay: 25 });
    return true;
  } catch (_) {
    // Fall through to DOM click fallback.
  }

  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    if (!(el instanceof HTMLElement)) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return true;
  }, selector);
}

/**
 * Reads pagination info from the "Showing X to Y of Z entries" text on the page.
 * @returns {{ from: number, to: number, total: number } | null}
 */
async function getPaginationInfo(page) {
  return page.evaluate(() => {
    const match = document.body.innerText.match(/showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)/i);
    if (match) {
      return { from: parseInt(match[1]), to: parseInt(match[2]), total: parseInt(match[3]) };
    }
    return null;
  });
}

/**
 * Builds a fingerprint for a DOM table row to detect duplicates across pages.
 * Uses order_number + referral_id as unique key.
 */
function recordKey(record) {
  return `${record.order_number || ''}|${record.referral_id || ''}|${record.created_at || ''}`;
}

/**
 * Fetches all commission records by paginating through pages.
 * Uses the "Showing X to Y of Z" text and duplicate detection to stop correctly.
 */
async function fetchAllCommissions(page, baseUrl, authToken, capturedResponses) {
  const allRecords = [];
  const seenKeys = new Set();

  /** Adds records, deduplicating by key. Returns count of new records added. */
  const addRecords = (records) => {
    let added = 0;
    for (const rec of records) {
      const key = recordKey(rec);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allRecords.push(rec);
        added++;
      }
    }
    return added;
  };

  // First, extract from any captured API responses
  if (capturedResponses.length > 0) {
    for (const { records } of capturedResponses) {
      if (records && Array.isArray(records)) {
        addRecords(records);
      }
    }
    if (allRecords.length > 0) {
      console.log(`   📥 Extracted ${allRecords.length} records from API responses`);
    }
  }

  // Read pagination info to know total
  const paginationInfo = await getPaginationInfo(page);
  const expectedTotal = paginationInfo?.total || null;
  if (paginationInfo) {
    console.log(`   📄 Pagination: showing ${paginationInfo.from}-${paginationInfo.to} of ${paginationInfo.total}`);
  }

  // DOM-based pagination
  let currentPage = 1;
  const maxPages = 50;

  // Extract page 1 from DOM if we don't have API data
  if (allRecords.length === 0) {
    const pageRecords = await extractFromDOM(page);
    const added = addRecords(pageRecords);
    console.log(`   📄 Page ${currentPage}: ${added} new records (${allRecords.length} total)`);
  }

  // Check if we already have all records
  if (expectedTotal && allRecords.length >= expectedTotal) {
    console.log(`   ✅ Already have all ${expectedTotal} records`);
    return allRecords;
  }

  // Click through pages
  while (currentPage < maxPages) {
    // Check if there is a next page to go to
    const nextPageNum = currentPage + 1;
    const canGoNext = await page.evaluate((targetPage) => {
      // Look for a specific page number link/button first (most reliable)
      const allClickable = document.querySelectorAll('button, a, [role="button"], .pagination li');
      for (const el of allClickable) {
        const text = el.textContent.trim();
        if (text === String(targetPage)) {
          // Check it's not the currently active page
          const isActive = el.classList.contains('active') ||
                           el.closest('li')?.classList.contains('active') ||
                           el.getAttribute('aria-current') === 'page';
          if (!isActive) {
            el.click();
            return 'clicked_page';
          }
        }
      }

      // Fall back to "Next" button
      for (const el of allClickable) {
        const text = el.textContent.trim().toLowerCase();
        if (text === 'next' || text === '›' || text === '»') {
          // Check if it's truly disabled (various ways sites disable)
          const isDisabled = el.disabled ||
                             el.classList.contains('disabled') ||
                             el.closest('li')?.classList.contains('disabled') ||
                             el.getAttribute('aria-disabled') === 'true' ||
                             el.style.pointerEvents === 'none' ||
                             el.style.opacity === '0.5' ||
                             el.tabIndex === -1;
          if (!isDisabled) {
            el.click();
            return 'clicked_next';
          }
        }
      }

      return null;
    }, nextPageNum);

    if (!canGoNext) {
      console.log(`   ✅ No more pages (stopped at page ${currentPage})`);
      break;
    }

    await sleep(3000);
    currentPage = nextPageNum;

    // Verify pagination actually changed
    const newPagInfo = await getPaginationInfo(page);

    const pageRecords = await extractFromDOM(page);
    const added = addRecords(pageRecords);

    if (added === 0) {
      console.log(`   ✅ Page ${currentPage}: 0 new records (all duplicates) — stopping`);
      break;
    }

    console.log(`   📄 Page ${currentPage}: ${added} new records (${allRecords.length} total)${newPagInfo ? ` [showing ${newPagInfo.from}-${newPagInfo.to} of ${newPagInfo.total}]` : ''}`);

    // Stop if we've reached the expected total
    if (expectedTotal && allRecords.length >= expectedTotal) {
      console.log(`   ✅ Reached expected total of ${expectedTotal} records`);
      break;
    }
  }

  return allRecords;
}

/**
 * Applies date filter on the commissions page
 */
async function applyDateFilter(page, startDate, endDate) {
  try {
    const dateFilterClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, [role="button"], .date-filter, [class*="date"]');
      for (const btn of buttons) {
        if (btn.textContent.toLowerCase().includes('date') ||
            btn.querySelector('svg[class*="calendar"]')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (dateFilterClicked) {
      await sleep(1000);
    }

    const dateInputs = await page.$$('input[type="date"], input[type="text"][placeholder*="date" i]');
    if (dateInputs.length >= 2) {
      if (startDate) {
        await dateInputs[0].click({ clickCount: 3 });
        await dateInputs[0].type(startDate);
      }
      if (endDate) {
        await dateInputs[1].click({ clickCount: 3 });
        await dateInputs[1].type(endDate);
      }

      const applyButton = await findSelector(page, [
        'button:has-text("Apply")',
        'button:has-text("Filter")',
        'button:has-text("Search")',
      ]);

      if (applyButton) {
        await page.click(applyButton);
        await sleep(2000);
      }
    }
  } catch (e) {
    console.warn('⚠️ Could not apply date filter:', e.message);
  }
}

/**
 * Extracts commission data from intercepted API responses
 */
function extractFromApiResponses(apiResponses) {
  const commissions = [];

  for (const { records } of apiResponses) {
    if (records && Array.isArray(records)) {
      commissions.push(...records);
    }
  }

  return commissions;
}

/**
 * Extracts commission data by parsing the DOM table
 */
async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const commissions = [];
    const table = document.querySelector('table, .data-table, [role="table"]');

    if (!table) {
      return commissions;
    }

    const headerRow = table.querySelector('thead tr, tr:first-child');
    const headers = [];
    if (headerRow) {
      headerRow.querySelectorAll('th, td').forEach(cell => {
        let header = cell.textContent.trim().toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_]/g, '');
        headers.push(header);
      });
    }

    const headerMap = {
      'create_at': 'created_at',
      'createat': 'created_at',
      'referral_id': 'referral_id',
      'referralid': 'referral_id',
      'order_number': 'order_number',
      'ordernumber': 'order_number',
      'customer_address': 'customer_address',
      'customeraddress': 'customer_address',
      'total_sales': 'total_sales',
      'totalsales': 'total_sales',
      'quantity': 'quantity',
      'commission': 'commission',
      'status': 'status',
      'source': 'source',
      'action': 'action',
    };

    const rows = table.querySelectorAll('tbody tr');

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length === 0) return;

      const record = {};
      cells.forEach((cell, index) => {
        const rawHeader = headers[index] || `column_${index}`;
        const header = headerMap[rawHeader] || rawHeader;
        let value = cell.textContent.trim();

        if (header === 'referral_id' || rawHeader.includes('referral')) {
          const link = cell.querySelector('a');
          if (link) {
            const match = link.href?.match(/order-detail\/(\d+)/);
            if (match) value = match[1];
          }
          const dataId = cell.getAttribute('data-id') || cell.querySelector('[data-id]')?.getAttribute('data-id');
          if (dataId) value = dataId;
        }

        if (header === 'total_sales' || header === 'commission') {
          value = value.replace(/[^0-9.-]/g, '');
        }

        if (header === 'created_at') {
          const dateSpan = cell.querySelector('[class*="date"], small, span');
          if (dateSpan) {
            record.created_at_display = dateSpan.textContent.trim();
          }
        }

        record[header] = value;
      });

      if (record.referral_id || record.order_number) {
        commissions.push(record);
      }
    });

    return commissions;
  });
}

/**
 * Debug function to explore the page structure
 */
export async function debugPageStructure({ email, password, baseUrl }) {
  const browser = await launchBrowser({ headless: false });
  const page = await createStealthPage(browser);

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    if (contentType.includes('application/json')) {
      console.log(`API Call: ${response.request().method()} ${url} - ${response.status()}`);
      try {
        const data = await response.json();
        console.log('Response:', JSON.stringify(data, null, 2).slice(0, 1000));
      } catch (e) {
        // Not JSON or already consumed
      }
    }
  });

  try {
    const LOGIN_URL = `${baseUrl}/commission`;
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('🔍 Browser opened for debugging. Press Ctrl+C to close.');
    await new Promise(() => {});
  } catch (error) {
    console.error('Debug session error:', error);
  }
}
