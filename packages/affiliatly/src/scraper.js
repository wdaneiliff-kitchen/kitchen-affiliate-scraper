import {
  sleep,
  findSelector,
  launchBrowser,
  createStealthPage,
  getCookieString,
} from '@kitchen/shared/scraper-base';
import { solveRecaptchaV2 } from './twocaptcha.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = resolve(__dirname, '../.cookies');

const LOGIN_URL = 'https://www.affiliatly.com/login.html?affiliates=1';

/**
 * Returns the path to the cookie file for a given account.
 * @param {string} accountId - Account identifier (e.g. 'engage')
 * @returns {string} Absolute path to the cookie JSON file
 */
function getCookiePath(accountId) {
  return resolve(COOKIES_DIR, `${accountId}-cookies.json`);
}

/**
 * Saves the current page cookies to disk for session reuse.
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string} accountId - Account identifier
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
 * Loads previously saved cookies into the page.
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string} accountId - Account identifier
 * @returns {Promise<boolean>} True if cookies were loaded successfully
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
    // No saved cookies or invalid file — will proceed to login
  }
  return false;
}

/**
 * Scrapes commission data from the Affiliatly affiliate dashboard.
 * Handles Google reCAPTCHA v2 via 2captcha auto-solve with manual fallback.
 *
 * @param {Object} options - Scraper options
 * @param {string} options.email - Affiliatly login email
 * @param {string} options.password - Affiliatly login password
 * @param {string} [options.accountId='engage'] - Account identifier for cookie persistence
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @param {string} [options.twoCaptchaKey] - Optional 2captcha API key for auto-solving
 * @returns {Promise<Array>} Array of commission objects
 */
export async function scrapeCommissions({ email, password, accountId = 'engage', headless = true, twoCaptchaKey }) {
  console.log('🚀 Starting Affiliatly scraper...');
  console.log(`   Account: ${accountId}`);
  console.log(`   Headless: ${headless}`);
  console.log(`   2Captcha: ${twoCaptchaKey ? 'enabled' : 'disabled'}`);

  let browser;
  try {
    console.log('🌐 Launching browser...');
    browser = await launchBrowser({ headless });
  } catch (launchError) {
    console.error('❌ Failed to launch browser:', launchError.message);
    throw launchError;
  }

  const page = await createStealthPage(browser);

  try {
    // Try loading saved cookies to skip login
    const hasCookies = await loadCookies(page, accountId);

    // Step 1: Navigate to login page (cookies may bypass it)
    console.log('📍 Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Check if saved cookies kept us logged in (redirected away from login)
    const stillOnLogin = page.url().includes('login');

    if (hasCookies && !stillOnLogin) {
      console.log('   ✅ Session cookies still valid — skipped login!');
    } else {
      if (hasCookies) {
        console.log('   ⚠️ Saved cookies expired — logging in fresh...');
      }

    // Wait for the login form to render
    await page.waitForSelector('input[type="email"], input[name="email"], input[type="text"], #email, .login-form input, input[type="password"]', {
      timeout: 15000,
    });

    if (process.env.DEBUG) {
      await page.screenshot({ path: 'affiliatly-login-page.png', fullPage: true });
      console.log('   📸 Saved debug screenshot: affiliatly-login-page.png');
    }

    // Step 2: Fill in login credentials
    console.log('🔐 Entering credentials...');

    // Find and fill the email/username field
    const emailSelector = await findSelector(page, [
      'input[name="email"]',
      'input[type="email"]',
      'input[name="username"]',
      'input[name="login"]',
      '#email',
      '#username',
      'input[placeholder*="email" i]',
      'input[placeholder*="user" i]',
      'form input[type="text"]',
      'form input[type="email"]',
    ]);

    if (!emailSelector) {
      const inputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
        }))
      );
      console.log('   Available inputs:', JSON.stringify(inputs, null, 2));
      throw new Error('Could not find email input field');
    }

    await page.type(emailSelector, email, { delay: 50 });
    console.log(`   ✅ Email entered (${emailSelector})`);

    await sleep(500);

    // Find and fill the password field
    const passwordSelector = await findSelector(page, [
      'input[name="password"]',
      'input[type="password"]',
      '#password',
      'input[placeholder*="password" i]',
    ]);

    if (!passwordSelector) {
      throw new Error('Could not find password input field');
    }

    await page.type(passwordSelector, password, { delay: 50 });
    console.log(`   ✅ Password entered (${passwordSelector})`);

    await sleep(500);

    // Step 3: Check for reCAPTCHA before submitting
    const hasCaptcha = await page.evaluate(() => {
      return document.querySelector('iframe[src*="recaptcha"]') !== null ||
             document.querySelector('.g-recaptcha') !== null ||
             document.querySelector('[data-sitekey]') !== null ||
             document.querySelector('[class*="recaptcha"]') !== null ||
             document.body.innerText.toLowerCase().includes('recaptcha') ||
             document.body.innerText.includes("I'm not a robot");
    });

    if (hasCaptcha) {
      // Try 2captcha if API key provided
      if (twoCaptchaKey) {
        console.log('\n🤖 reCAPTCHA detected - attempting auto-solve with 2captcha...');
        const solved = await solve2Captcha(page, twoCaptchaKey);
        if (!solved) {
          console.log('   ⚠️ Auto-solve failed, falling back to manual...');
        }
      }

      // Check if we already navigated away from login (2captcha may have succeeded)
      const alreadyLoggedIn = !page.url().includes('login') || await page.evaluate(() => {
        return document.querySelector('input[type="password"]') === null;
      });

      if (alreadyLoggedIn) {
        console.log('   ✅ 2captcha solved CAPTCHA and login succeeded!');
      } else {
        console.log('\n🤖 reCAPTCHA still present — manual solving may be needed.');

        if (headless) {
          throw new Error('CAPTCHA detected but running in headless mode. Please run with --visible flag to solve manually.');
        }

        console.log('   ⏸️  Please solve the CAPTCHA in the browser window...');
        console.log('   ⏳ Waiting up to 120 seconds...\n');

        // Wait for CAPTCHA to be solved
        let captchaSolved = false;
        let loginClickedAt = 0; // tracks when we last clicked login to avoid spamming

        for (let i = 0; i < 60; i++) {
          await sleep(2000);

          // Check if we've navigated away from login
          const stillOnLogin = await page.evaluate(() => {
            return document.querySelector('input[type="password"]') !== null;
          });

          if (!stillOnLogin) {
            captchaSolved = true;
            console.log('   ✅ CAPTCHA solved and login successful!');
            break;
          }

          // Check if reCAPTCHA has a solved token (green checkmark / response filled)
          const captchaState = await page.evaluate(() => {
            const textarea = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
            const hasToken = textarea && textarea.value && textarea.value.length > 20;
            const hasCheckmark = document.querySelector('.recaptcha-checkbox-checked') !== null;
            return { hasToken, hasCheckmark };
          });

          const looksActuallySolved = captchaState.hasToken || captchaState.hasCheckmark;

          if (looksActuallySolved && (i - loginClickedAt) >= 3) {
            // Only try clicking login once every ~6s to avoid spamming
            console.log('   🔄 CAPTCHA appears solved, clicking login...');
            loginClickedAt = i;

            const loginBtn = await findSelector(page, [
              'button[type="submit"]',
              'input[type="submit"]',
              'form button',
            ]);

            if (loginBtn) {
              await page.click(loginBtn);
              await sleep(3000);

              // Check if we navigated after clicking
              const navigated = await page.evaluate(() => {
                return document.querySelector('input[type="password"]') === null;
              });

              if (navigated) {
                captchaSolved = true;
                console.log('   ✅ Login successful after CAPTCHA!');
                break;
              }

              // If still on login, the token may be stale/invalid — tell user
              console.log('   ⚠️ Login click did not navigate — CAPTCHA token may be invalid.');
              console.log('   ⏸️  Please re-solve the CAPTCHA manually in the browser...');
            }
          }

          if (i % 10 === 0 && i > 0) {
            console.log(`   ⏳ Still waiting... (${i * 2}s)`);
          }
        }

        if (!captchaSolved) {
          const finalCheck = await page.evaluate(() => {
            return document.querySelector('input[type="password"]') !== null;
          });
          if (finalCheck) {
            throw new Error('CAPTCHA not solved in time. Try again with --visible flag.');
          }
        }
      }
    } else {
      // No CAPTCHA, proceed with normal login
      console.log('🔑 Submitting login...');

      await page.evaluate(() => {
        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button.login-btn',
          'button.btn-login',
          '.login-form button',
          'form button',
          '#login-btn',
          'a.login-btn',
        ];

        for (const selector of submitSelectors) {
          const btn = document.querySelector(selector);
          if (btn) {
            btn.click();
            return;
          }
        }

        // Try submitting the form directly
        const form = document.querySelector('form');
        if (form) {
          form.submit();
          return;
        }

        // Last resort: any button with login-like text
        const buttons = Array.from(document.querySelectorAll('button, input[type="button"], a.btn'));
        const loginBtn = buttons.find(b => {
          const text = (b.textContent || b.value || '').toLowerCase();
          return text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('submit');
        });
        if (loginBtn) loginBtn.click();
      });

      // Wait for navigation after login
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    await sleep(3000);

    // Check if login was successful
    let currentUrl = page.url();
    console.log(`   Current URL after login: ${currentUrl}`);

    if (currentUrl.includes('login')) {
      const errorMsg = await page.evaluate(() => {
        const errorEl = document.querySelector('.error, .alert-danger, .login-error, [class*="error"]');
        return errorEl ? errorEl.textContent.trim() : null;
      });

      if (errorMsg) {
        throw new Error(`Login failed: ${errorMsg}`);
      }
      throw new Error('Login failed - still on login page. Check credentials.');
    }

    console.log('   ✅ Login successful!');

    // Save cookies so next run can skip login + CAPTCHA
    await saveCookies(page, accountId);

    } // end of login block (cookies were expired or absent)

    // Step 4: Navigate to the Orders page
    await navigateToOrders(page);

    // Step 5: Set date filter to a wide range so we capture all commissions
    await setDateFilter(page);

    // Take a screenshot for debugging
    await page.screenshot({ path: 'affiliatly-dashboard.png', fullPage: true });
    console.log('   📸 Saved debug screenshot: affiliatly-dashboard.png');

    // Step 6: Try to load all records (pagination / "show all")
    await tryLoadAllRecords(page);

    // Step 7: Extract data from DOM
    console.log('📄 Extracting commission data from page...');
    let commissions = await extractFromDOM(page);

    if (commissions.length === 0) {
      console.log('⚠️ No data found on current page. Dumping page info for debugging...');

      const pageInfo = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        const dataElements = document.querySelectorAll('[class*="table"], [class*="data"], [class*="list"], [class*="order"], [class*="commission"]');
        return {
          tableCount: tables.length,
          dataElements: dataElements.length,
          title: document.title,
          url: window.location.href,
          bodyText: document.body.innerText.slice(0, 2000),
        };
      });
      console.log(`   Tables found: ${pageInfo.tableCount}`);
      console.log(`   Data-like elements: ${pageInfo.dataElements}`);
      console.log(`   Page title: ${pageInfo.title}`);
      console.log(`   URL: ${pageInfo.url}`);
      console.log(`   Page text preview:\n${pageInfo.bodyText.slice(0, 500)}...`);
    }

    // Update cookies after successful scrape (extends session lifetime)
    await saveCookies(page, accountId);

    console.log(`\n✅ Scraped ${commissions.length} commission records`);
    return commissions;

  } catch (error) {
    console.error('❌ Scraping failed:', error.message);
    const screenshotPath = `affiliatly-error-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
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
      '#g-recaptcha-response, textarea[name="g-recaptcha-response"]'
    );
    textareas.forEach((el) => {
      el.value = t;
      el.innerHTML = t;
    });

    // 2. Try data-callback attribute on the widget element
    const widget = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (widget) {
      const callbackName = widget.getAttribute('data-callback');
      if (callbackName && typeof window[callbackName] === 'function') {
        window[callbackName](t);
        return true;
      }
    }

    // 3. Walk ___grecaptcha_cfg.clients to find the callback
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

    // 4. Try common global callback names as last resort
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
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string} apiKey - 2Captcha API key
 * @returns {Promise<boolean>} True if solved successfully
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
    console.log(`   ${callbackInvoked ? '✅ Callback invoked' : '⚠️ No callback found, token set in textarea only'}`);

    await sleep(500);

    // Click submit after solving captcha
    const loginBtn = await findSelector(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'form button',
    ]);
    if (loginBtn) {
      await page.click(loginBtn);
      await sleep(3000);
    }

    return true;
  } catch (error) {
    console.log(`   ❌ 2captcha error: ${error.message}`);
    return false;
  }
}

/**
 * Navigates specifically to the Orders page in the Affiliatly affiliate dashboard.
 * Looks for the "Orders" nav tab and clicks it.
 */
async function navigateToOrders(page) {
  console.log('📊 Navigating to Orders page...');
  await sleep(2000);

  const result = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));

    // Look for exact "Orders" link in the top navigation
    const ordersLink = links.find(a => /^\s*Orders\s*$/i.test(a.textContent));
    if (ordersLink) {
      ordersLink.click();
      return { clicked: true, text: ordersLink.textContent.trim(), href: ordersLink.href };
    }

    // Fallback: link whose href contains "order"
    const fallback = links.find(a => (a.href || '').toLowerCase().includes('order'));
    if (fallback) {
      fallback.click();
      return { clicked: true, text: fallback.textContent.trim(), href: fallback.href };
    }

    return {
      clicked: false,
      available: links
        .map(a => ({ text: a.textContent.trim().slice(0, 40), href: a.href }))
        .filter(l => l.text.length > 0)
        .slice(0, 25),
    };
  });

  if (result.clicked) {
    console.log(`   ✅ Clicked "${result.text}" (${result.href})`);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(3000);
  } else {
    console.log('   ⚠️ Could not find Orders link');
    console.log('   Available links:', JSON.stringify(result.available, null, 2));
  }

  console.log(`   Current URL: ${page.url()}`);
  return result.clicked;
}

/**
 * Sets the date filter on the Affiliatly Orders page to a wide range and clicks "Show".
 *
 * The Orders page has two text inputs labelled "from:" and "to:" with dates in
 * Mon/DD/YYYY format (e.g. "Feb/01/2026") and a green "Show" button.
 * We widen the range to capture all available commissions.
 */
async function setDateFilter(page) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const now = new Date();
  const toDate = `${MONTHS[now.getUTCMonth()]}/${String(now.getUTCDate()).padStart(2, '0')}/${now.getUTCFullYear()}`;
  // Go back 2 years to be safe
  const fromDate = `Jan/01/${now.getUTCFullYear() - 2}`;

  console.log(`📅 Setting date filter: ${fromDate} → ${toDate}`);

  const result = await page.evaluate((from, to) => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const datePattern = /^[A-Z][a-z]{2}\/\d{2}\/\d{4}$/;

    // Strategy 1: find inputs whose current value looks like a date (Mon/DD/YYYY)
    let dateInputs = inputs.filter(inp => datePattern.test(inp.value));

    // Strategy 2: find text-like inputs inside the same parent as "from" / "to" text
    if (dateInputs.length < 2) {
      dateInputs = [];
      for (const input of inputs) {
        if (input.type === 'password' || input.type === 'email' || input.type === 'hidden') continue;
        const parent = input.parentElement;
        if (!parent) continue;
        const siblingText = parent.textContent.toLowerCase();
        if (siblingText.includes('from') || siblingText.includes('to')) {
          dateInputs.push(input);
        }
      }
    }

    if (dateInputs.length < 2) {
      return {
        success: false,
        reason: `Found ${dateInputs.length} date inputs (need 2)`,
        allInputs: inputs.map(i => ({ type: i.type, name: i.name, id: i.id, value: i.value?.slice(0, 30) })),
      };
    }

    // Use the native setter so frameworks see the change
    const setVal = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setVal(dateInputs[0], from);
    setVal(dateInputs[1], to);

    // Click the "Show" button
    const clickables = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a'));
    const showBtn = clickables.find(el => /^\s*Show\s*$/i.test((el.textContent || el.value || '').trim()));
    if (showBtn) {
      showBtn.click();
      return { success: true, from: dateInputs[0].value, to: dateInputs[1].value, clickedShow: true };
    }

    // Fallback: submit the enclosing form
    const form = dateInputs[0].closest('form');
    if (form) {
      form.submit();
      return { success: true, from: dateInputs[0].value, to: dateInputs[1].value, submittedForm: true };
    }

    return { success: true, from: dateInputs[0].value, to: dateInputs[1].value, clickedShow: false };
  }, fromDate, toDate);

  if (result.success) {
    console.log(`   ✅ Date filter set: ${result.from} → ${result.to}`);
    if (result.clickedShow || result.submittedForm) {
      // Wait for page reload with new date range
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(3000);
    }
  } else {
    console.log(`   ⚠️ ${result.reason}`);
    if (process.env.DEBUG && result.allInputs) {
      console.log('   Inputs found:', JSON.stringify(result.allInputs, null, 2));
    }
  }

  return result.success;
}

/**
 * Attempts to load all records by clicking "show all", pagination, or adjusting rows per page
 */
async function tryLoadAllRecords(page) {
  console.log('📄 Attempting to load all records...');

  // Try clicking "Show All" or adjusting rows per page
  const loadAllResult = await page.evaluate(() => {
    const allButtons = Array.from(document.querySelectorAll('a, button, select option'));
    const showAll = allButtons.find(el => {
      const text = (el.textContent || el.value || '').toLowerCase();
      return text.includes('show all') || text.includes('view all') || text === 'all' || text === '100' || text === '250' || text === '500';
    });

    if (showAll) {
      if (showAll.tagName === 'OPTION') {
        showAll.parentElement.value = showAll.value;
        showAll.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
        return { action: 'select', value: showAll.value };
      }
      showAll.click();
      return { action: 'click', text: showAll.textContent.trim() };
    }

    const selects = Array.from(document.querySelectorAll('select'));
    const perPageSelect = selects.find(s => {
      const options = Array.from(s.options).map(o => o.value);
      return options.some(v => v === '100' || v === '250' || v === '500' || v === 'all');
    });

    if (perPageSelect) {
      const maxOption = Array.from(perPageSelect.options)
        .sort((a, b) => (parseInt(b.value) || 9999) - (parseInt(a.value) || 9999))[0];
      perPageSelect.value = maxOption.value;
      perPageSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return { action: 'select-max', value: maxOption.value };
    }

    return { action: 'none' };
  });

  if (loadAllResult.action !== 'none') {
    console.log(`   ✅ ${loadAllResult.action}: ${loadAllResult.value || loadAllResult.text}`);
    await sleep(3000);
  }

  // Paginate through all pages if there's pagination
  let pageNum = 1;
  let hasMore = true;

  while (hasMore && pageNum < 50) {
    // Snapshot current page content so we can detect if clicking "next" actually moved us
    const beforeHash = await page.evaluate(() => document.body.innerText.length + '|' + document.body.innerText.slice(0, 500));

    const nextResult = await page.evaluate(() => {
      const nextSelectors = [
        'a.next', '.pagination .next a', 'a[rel="next"]',
        '.next-page', 'a[aria-label="Next"]',
      ];

      for (const selector of nextSelectors) {
        try {
          const el = document.querySelector(selector);
          if (el && !el.classList.contains('disabled') && !el.parentElement.classList.contains('disabled')) {
            el.click();
            return { found: true, selector };
          }
        } catch (e) {}
      }

      // Only match explicit "next" text — avoid ambiguous single-char like › or »
      const links = Array.from(document.querySelectorAll('a'));
      const nextLink = links.find(a => {
        const text = a.textContent.trim().toLowerCase();
        return (text === 'next' || text === 'next »' || text === 'next ›') &&
               !a.classList.contains('disabled');
      });

      if (nextLink) {
        nextLink.click();
        return { found: true, selector: 'text-match' };
      }

      return { found: false };
    });

    if (nextResult.found) {
      pageNum++;
      console.log(`   📄 Loading page ${pageNum}...`);
      await sleep(2000);
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});

      // Check if the page actually changed — if not, we've looped back to the same page
      const afterHash = await page.evaluate(() => document.body.innerText.length + '|' + document.body.innerText.slice(0, 500));
      if (afterHash === beforeHash) {
        console.log(`   ℹ️ Page content unchanged — no more pages.`);
        hasMore = false;
      }
    } else {
      hasMore = false;
    }
  }

  if (pageNum > 1) {
    console.log(`   ✅ Loaded ${pageNum} pages of data`);
  }
}

/**
 * Extracts commission data by finding the commission/orders table and parsing it.
 * Scores tables by how many commission-relevant headers they contain (Price, Earnings,
 * Date, etc.) so we pick the correct table even if a settings table has more rows.
 *
 * @param {Page} page - Puppeteer page
 * @returns {Promise<Array>} Array of commission objects keyed by normalised header names
 */
async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const commissions = [];
    const tables = document.querySelectorAll('table');

    if (tables.length === 0) {
      // No tables at all – try loose row extraction as a last resort
      const rows = document.querySelectorAll(
        '[class*="order"], [class*="commission"], [class*="transaction"]'
      );
      rows.forEach(row => {
        const textContent = row.textContent.trim();
        if (textContent.includes('$') || /\d+\.\d{2}/.test(textContent)) {
          commissions.push({ raw_text: textContent });
        }
      });
      return commissions;
    }

    // Keywords that signal a commission / orders table header
    const COMMISSION_KEYWORDS = [
      'price', 'earnings', 'date', 'order', 'commission', 'amount',
      'total', 'status', 'revenue', 'tracking', 'referring', 'landing',
    ];

    // Score each table: +10 per commission-keyword header, +1 per data row
    let bestTable = null;
    let bestScore = -1;

    tables.forEach(table => {
      const headerRow = table.querySelector('thead tr, tr:first-child');
      if (!headerRow) return;

      const headerTexts = Array.from(headerRow.querySelectorAll('th, td'))
        .map(cell => cell.textContent.trim().toLowerCase());

      let score = 0;
      for (const h of headerTexts) {
        if (COMMISSION_KEYWORDS.some(kw => h.includes(kw))) score += 10;
      }

      const rowCount = table.querySelectorAll('tbody tr').length ||
                        (table.querySelectorAll('tr').length - 1);
      score += Math.max(rowCount, 0);

      if (score > bestScore) {
        bestScore = score;
        bestTable = table;
      }
    });

    if (!bestTable) bestTable = tables[0];

    // Extract normalised headers
    const headerRow = bestTable.querySelector('thead tr, tr:first-child');
    const headers = [];
    if (headerRow) {
      headerRow.querySelectorAll('th, td').forEach(cell => {
        const text = cell.textContent.trim().toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_#]/g, '');
        headers.push(text);
      });
    }

    // Extract data rows
    const dataRows = bestTable.querySelectorAll('tbody tr');
    const rows = dataRows.length > 0
      ? dataRows
      : bestTable.querySelectorAll('tr:not(:first-child)');

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length === 0) return;

      const record = {};
      cells.forEach((cell, index) => {
        const header = headers[index] || `column_${index}`;
        record[header] = cell.textContent.trim();
      });

      // Only include rows that have at least some visible content
      const hasContent = Object.values(record).some(v => v.length > 0);
      if (hasContent) {
        commissions.push(record);
      }
    });

    return commissions;
  });
}

/**
 * Debug function to explore the Affiliatly page structure
 */
export async function debugPageStructure({ email, password }) {
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
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('🔍 Browser opened for debugging.');
    console.log('   Log in manually and navigate to the Commissions page.');
    console.log('   Watch the console for API calls.');
    console.log('   Press Ctrl+C to close.');
    await new Promise(() => {});
  } catch (error) {
    console.error('Debug session error:', error);
  }
}
