import {
  sleep,
  findSelector,
  launchBrowser,
  createStealthPage,
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
    // The data fetch happens via the DataTables AJAX endpoint (see
    // fetchAllCommissionsFromApi), so this dump is purely for debugging when
    // the page itself loads wrong (cookie expiry, layout change, redirect).
    try {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  🔍 DIAGNOSTIC: Page Structure');
    console.log('══════════════════════════════════════════════════════════');

    // DOM table structure
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

    // Save the smaller page-state diagnostic
    const diagPath = `uppromote-diagnostic-${Date.now()}.json`;
    await writeFile(diagPath, JSON.stringify({ url: page.url(), domDiag }, null, 2));
    console.log(`\n💾 Full diagnostic saved to: ${diagPath}`);
    console.log('══════════════════════════════════════════════════════════\n');
    } catch (diagError) {
      console.warn(`⚠️ Diagnostic logging failed (non-fatal): ${diagError.message}`);
      console.warn(diagError.stack);
    }
    // ── End diagnostic dump ──────────────────────────────────────────────

    // Fetch all commission records via UpPromote's DataTables AJAX endpoint.
    // This bypasses the page's default 30-day date filter (which silently
    // hid lifetime data when the scraper relied on DOM extraction).
    const commissions = await fetchAllCommissionsFromApi(page, baseUrl, { startDate, endDate });

    if (commissions.length === 0) {
      // Save a screenshot to help diagnose whether the page itself loaded wrong.
      // A genuinely-zero brand also lands here — that's not an error.
      await page.screenshot({ path: 'debug-uppromote-page.png', fullPage: true });
      console.log(`   📸 Saved debug-uppromote-page.png (URL: ${page.url()})`);
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

    // 1b. Ensure the token is sent on native form submit. reCAPTCHA's textarea is often
    //     injected outside the form (e.g. at end of body), so form.submit() won't include it.
    //     UpPromote uses a classic POST form (no data-callback); add a hidden input inside
    //     the form so the POST body always contains g-recaptcha-response.
    const form = document.querySelector('form[id="login-form"], form[action*="login"]') || document.querySelector('form');
    if (form) {
      const existing = form.querySelector('input[name="g-recaptcha-response"]');
      if (existing) existing.value = t;
      else {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'g-recaptcha-response';
        hidden.value = t;
        form.appendChild(hidden);
      }
    }

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

    // Give the page's JS time to see the patched getResponse() (important in headless/CI).
    await sleep(1500);

    // Scroll submit button into view so it's not covered by reCAPTCHA iframe (common in headless).
    const loginBtnSelector = await findSelector(page, [
      'button[type="submit"]',
      'input[type="submit"]',
    ]);
    if (loginBtnSelector) {
      await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (btn) btn.scrollIntoView({ block: 'center', inline: 'center' });
      }, loginBtnSelector);
      await sleep(300);
    }

    // Try clicking the submit button (with waitForNavigation so we don't race ahead).
    if (loginBtnSelector) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        safeClick(page, loginBtnSelector),
      ]);
      await sleep(2000);
    }

    // Check if we navigated away from login
    let afterClickState = await page.evaluate(() => {
      return document.querySelector('input[type="password"]') !== null;
    });
    if (!afterClickState) {
      console.log('   ✅ Login submit succeeded after CAPTCHA solve');
      return true;
    }

    // Button click didn't navigate. Many Laravel/JS forms use a submit handler that calls
    // grecaptcha.getResponse() and then does fetch() — form.submit() does NOT fire that
    // event, so the handler never runs. Dispatch a synthetic submit event so the handler
    // runs with our patched getResponse() (works in headless/CI where click may not trigger).
    console.log('   🔁 Dispatching submit event so form handler runs with token...');
    const submitEventDispatched = await page.evaluate(() => {
      const form = document.querySelector('form');
      const btn = document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]');
      if (form && btn) {
        const ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: btn });
        form.dispatchEvent(ev);
        return true;
      }
      return false;
    });
    if (submitEventDispatched) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(2000);
      afterClickState = await page.evaluate(() => document.querySelector('input[type="password"]') !== null);
      if (!afterClickState) {
        console.log('   ✅ Submit event triggered login');
        return true;
      }
    }

    // Last resort: native form.submit() (sends g-recaptcha-response in form body).
    console.log('   🔁 Trying native form.submit()...');
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

// ─── DataTables API fetch ─────────────────────────────────────────────────
// UpPromote serves the commission table from a server-rendered Laravel page
// that hydrates via a DataTables AJAX endpoint at /datatables/commission.
// The page's date picker (jQuery daterangepicker) defaults to "last 30 days"
// and rewrites the `from`/`to` Unix-timestamp query params before each fetch.
//
// We bypass the picker entirely and call the endpoint ourselves with
// `from=0`, which UpPromote treats as "no lower bound" — i.e. all-time data.
// This recovers historical commissions that have aged out of the default
// 30-day window (and were being deleted from the sheet as ghosts).

const COLUMN_NAMES = [
  'created_at', 'id', 'order_number', 'full_name', 'shipping_address',
  'total', 'quantity', 'commission', 'status', 'sca_source', 'id', 'affiliate_coupon',
];
const API_PAGE_SIZE = 100;

function buildDatatablesUrl(baseUrl, { start, length, from, to }) {
  // DataTables requires column metadata for each visible column. UpPromote's
  // backend only reads a handful of these (start/length/from/to/status), but
  // the request is rejected if columns[] isn't sent — so we send minimal stubs.
  const params = new URLSearchParams();
  params.set('draw', '1');
  for (let i = 0; i < COLUMN_NAMES.length; i++) {
    params.set(`columns[${i}][data]`, COLUMN_NAMES[i]);
    params.set(`columns[${i}][name]`, '');
    params.set(`columns[${i}][searchable]`, 'true');
    params.set(`columns[${i}][orderable]`, 'true');
    params.set(`columns[${i}][search][value]`, '');
    params.set(`columns[${i}][search][regex]`, 'false');
  }
  params.set('order[0][column]', '0');
  params.set('order[0][dir]', 'desc');
  params.set('start', String(start));
  params.set('length', String(length));
  params.set('search[value]', '');
  params.set('search[regex]', 'false');
  params.set('sca_source', '');
  params.set('status', '-1'); // -1 = all statuses (pending + approved + paid + denied)
  params.set('from', String(from));
  params.set('to', String(to));
  params.set('_', String(Date.now()));
  return `${baseUrl}/datatables/commission?${params.toString()}`;
}

/**
 * Fetches ALL commission records for the brand from UpPromote's DataTables
 * endpoint, paginated. Runs inside the page context so the session cookies
 * (laravel_session, XSRF-TOKEN) authenticate the request automatically.
 *
 * @param {import('puppeteer').Page} page - logged-in page on /{accountId}/commission
 * @param {string} baseUrl - account base URL (e.g. https://af.uppromote.com/Udrippin)
 * @param {{ startDate?: string, endDate?: string }} [opts]
 *   `startDate`/`endDate` are optional YYYY-MM-DD strings. Defaults to
 *   from=0 (epoch, i.e. all-time) and to=now.
 * @returns {Promise<Array>} Records in raw API shape. The platform's
 *   `recordsTotal` is attached as a non-enumerable `_platformTotal` for the
 *   nightly accuracy audit.
 */
async function fetchAllCommissionsFromApi(page, baseUrl, { startDate, endDate } = {}) {
  const fromUnix = startDate
    ? Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000)
    : 0;
  const toUnix = endDate
    ? Math.floor(Date.parse(`${endDate}T23:59:59Z`) / 1000)
    : Math.floor(Date.now() / 1000);

  console.log(`📄 Fetching commissions via DataTables API (from=${fromUnix}, to=${toUnix})...`);

  const all = [];
  let totalRecords = null;
  let start = 0;

  while (true) {
    const url = buildDatatablesUrl(baseUrl, { start, length: API_PAGE_SIZE, from: fromUnix, to: toUnix });
    const response = await page.evaluate(async (u) => {
      const r = await fetch(u, {
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }, url);

    const records = response.data || [];
    if (totalRecords === null) {
      totalRecords = Number.isFinite(response.recordsTotal) ? response.recordsTotal : 0;
      console.log(`   📊 Platform reports ${totalRecords} total records`);
    }
    all.push(...records);
    console.log(`   📄 Page ${Math.floor(start / API_PAGE_SIZE) + 1}: fetched ${records.length} (running total ${all.length}/${totalRecords})`);

    // Stop on either: caught up to platform-reported total, or got a short page.
    if (records.length < API_PAGE_SIZE) break;
    if (all.length >= totalRecords) break;
    start += API_PAGE_SIZE;
  }

  Object.defineProperty(all, '_platformTotal', { value: totalRecords ?? 0, enumerable: false });
  return all;
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
