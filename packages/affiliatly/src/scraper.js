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

const DEFAULT_LOGIN_URL = 'https://www.affiliatly.com/login.html?affiliates=1';

/** Max time to wait for the reCAPTCHA v2 widget (sitekey + anchor iframe). Affiliatly can load slowly. */
const RECAPTCHA_WIDGET_TIMEOUT_MS = Number(process.env.AFFILIATLY_RECAPTCHA_LOAD_MS) || 150000;

// #region agent log
/** @param {{ hypothesisId: string, location: string, message: string, data?: Record<string, unknown>, runId?: string }} p */
function agentDebugLog(p) {
  fetch('http://127.0.0.1:7245/ingest/4c8d336a-0bc0-4129-bb3e-96c357aadcc9', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b94194' },
    body: JSON.stringify({
      sessionId: 'b94194',
      hypothesisId: p.hypothesisId,
      location: p.location,
      message: p.message,
      data: p.data,
      runId: p.runId,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}
// #endregion

/**
 * Waits until reCAPTCHA v2 exposes a sitekey and the anchor iframe is in the DOM.
 * Program-specific affiliate panels (e.g. …/af-XXXXX/affiliate.panel) often load recaptcha/api.js
 * but only show a math captcha — no data-sitekey. A single long waitForFunction would block for
 * the full timeout; we first wait briefly for a sitekey, then bail if this page has no widget.
 * @param {import('puppeteer').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} True if the widget became ready, false on timeout
 */
async function waitForRecaptchaWidget(page, timeoutMs) {
  const start = Date.now();
  const sitekeyProbeMs = Math.min(12000, timeoutMs);

  try {
    await page.waitForFunction(
      () => {
        const el =
          document.querySelector('.g-recaptcha[data-sitekey]') ||
          document.querySelector('[data-sitekey]');
        const sk = el?.getAttribute('data-sitekey');
        return !!(sk && sk.length >= 20);
      },
      { timeout: sitekeyProbeMs }
    );
  } catch {
    const waitedMs = Date.now() - start;
    console.log(
      `   ℹ️ No reCAPTCHA sitekey on this page (${Math.round(waitedMs / 1000)}s) — math captcha / non-reCAPTCHA login`
    );
    return false;
  }

  try {
    await page.waitForFunction(
      () => document.querySelector('iframe[src*="recaptcha"]') !== null,
      { timeout: timeoutMs }
    );
    const waitedMs = Date.now() - start;
    // #region agent log
    agentDebugLog({
      hypothesisId: 'H-SLOW',
      location: 'scraper.js:waitForRecaptchaWidget',
      message: 'reCAPTCHA widget ready',
      data: { waitedMs, ok: true, timeoutMs },
    });
    // #endregion
    console.log(`   ✅ reCAPTCHA loaded (${Math.round(waitedMs / 1000)}s)`);
    return true;
  } catch {
    const waitedMs = Date.now() - start;
    // #region agent log
    agentDebugLog({
      hypothesisId: 'H-SLOW',
      location: 'scraper.js:waitForRecaptchaWidget',
      message: 'reCAPTCHA widget wait timed out',
      data: { waitedMs, ok: false, timeoutMs },
    });
    // #endregion
    console.log(`   ⚠️ reCAPTCHA not fully loaded within ${Math.round(timeoutMs / 1000)}s`);
    return false;
  }
}

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
 * Sets email/password (and math captcha if present). Use after a reload or before a CAPTCHA retry
 * so fields are not empty when the login page re-renders.
 * @param {import('puppeteer').Page} page
 * @param {string} email
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function fillAffiliatlyCredentials(page, email, password) {
  if (!email || !password) return false;

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
  const passwordSelector = await findSelector(page, [
    'input[name="password"]',
    'input[type="password"]',
    '#password',
    'input[placeholder*="password" i]',
  ]);

  if (!emailSelector || !passwordSelector) {
    console.warn('   ⚠️ Could not find login fields to re-fill');
    return false;
  }

  const fieldsWereEmpty = await page.evaluate(
    (eSel, pSel) => {
      const e = document.querySelector(eSel);
      const p = document.querySelector(pSel);
      return !String(e?.value || '').trim() || !String(p?.value || '').trim();
    },
    emailSelector,
    passwordSelector
  );

  await page.evaluate(
    ({ emailSel, passSel, em, pw }) => {
      const apply = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      apply(emailSel, em);
      apply(passSel, pw);
    },
    { emailSel: emailSelector, passSel: passwordSelector, em: email, pw: password }
  );

  const mathCaptchaResult = await page.evaluate(() => {
    const captchaInput = document.querySelector('input[name="captcha"]');
    if (!captchaInput) return null;
    const container = captchaInput.closest('.form-group') || captchaInput.parentElement;
    const label = container?.querySelector('label');
    if (!label) return null;
    const text = label.textContent.trim();
    const match = text.match(/(\d+)\s*([+\-*×÷/])\s*(\d+)/);
    if (!match) return null;
    const a = parseInt(match[1], 10);
    const op = match[2];
    const b = parseInt(match[3], 10);
    let answer;
    switch (op) {
      case '+': answer = a + b; break;
      case '-': answer = a - b; break;
      case '*': case '×': answer = a * b; break;
      case '/': case '÷': answer = Math.floor(a / b); break;
      default: return null;
    }
    return String(answer);
  });

  if (mathCaptchaResult) {
    await page.evaluate((ans) => {
      const el = document.querySelector('input[name="captcha"]');
      if (el) {
        el.value = ans;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, mathCaptchaResult);
  }

  if (fieldsWereEmpty) {
    console.log('   🔐 Credentials re-filled (fields were empty — e.g. after refresh)');
  }
  return true;
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
 * @param {string} [options.loginUrl] - Account-specific login URL
 * @param {string} [options.userAffiliateProgramId] - Optional program id when generic login lists multiple programs
 * @param {string} [options.twoCaptchaKey] - Optional 2captcha API key for auto-solving
 * @returns {Promise<Array>} Array of commission objects
 */
export async function scrapeCommissions({
  email,
  password,
  accountId = 'engage',
  headless = true,
  loginUrl,
  userAffiliateProgramId,
  twoCaptchaKey,
}) {
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
    // Skip "I agree" cookie banner (overlays the form in visible mode; same cookie checkLegalCookie sets)
    await page.setCookie({
      name: 'legal_cookie',
      value: 'agree=1',
      domain: 'www.affiliatly.com',
      path: '/',
    }).catch(() => {});

    // Try loading saved cookies to skip login
    const hasCookies = await loadCookies(page, accountId);

    // Step 1: Navigate to login page (cookies may bypass it)
    const targetLoginUrl = loginUrl || DEFAULT_LOGIN_URL;
    console.log(`📍 Navigating to login page: ${targetLoginUrl}`);
    await page.goto(targetLoginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Check if saved cookies kept us logged in (no password field = already logged in)
    const stillOnLogin = await page.evaluate(() =>
      document.querySelector('input[type="password"]') !== null
    );

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

    // Step 2b: Solve simple math captcha if present (e.g., "2 + 2 equals")
    const mathCaptchaResult = await page.evaluate(() => {
      const captchaInput = document.querySelector('input[name="captcha"]');
      if (!captchaInput) return null;

      const container = captchaInput.closest('.form-group') || captchaInput.parentElement;
      const label = container?.querySelector('label');
      if (!label) return null;

      const text = label.textContent.trim();
      const match = text.match(/(\d+)\s*([+\-*×÷/])\s*(\d+)/);
      if (!match) return null;

      const a = parseInt(match[1]);
      const op = match[2];
      const b = parseInt(match[3]);

      let answer;
      switch (op) {
        case '+': answer = a + b; break;
        case '-': answer = a - b; break;
        case '*': case '×': answer = a * b; break;
        case '/': case '÷': answer = Math.floor(a / b); break;
        default: return null;
      }

      return { answer: String(answer), text };
    });

    if (mathCaptchaResult) {
      await page.type('input[name="captcha"]', mathCaptchaResult.answer, { delay: 50 });
      console.log(`   ✅ Math captcha solved: "${mathCaptchaResult.text}" → ${mathCaptchaResult.answer}`);
    }

    await sleep(500);

    // #region agent log
    {
      const loginDiag = await page.evaluate(() => {
        const forms = [...document.querySelectorAll('form')].map((f, i) => ({
          i,
          action: (f.action || '').slice(0, 120),
          method: f.method || 'get',
          inputNames: [...f.querySelectorAll('input, textarea, select')]
            .map((el) => el.name || el.id || el.type)
            .filter(Boolean),
        }));
        const radios = [...document.querySelectorAll('input[type="radio"]')].map((r) => ({
          name: r.name,
          value: r.value,
          checked: r.checked,
        }));
        const selectedTypeHint = [...document.querySelectorAll('a, button, li, label, span')]
          .filter((el) => /store owner|advertiser|affiliate|publisher|staff/i.test(el.textContent || ''))
          .slice(0, 8)
          .map((el) => (el.textContent || '').trim().slice(0, 80));
        return {
          href: location.href,
          forms,
          radios,
          selectedTypeHint,
        };
      });
      agentDebugLog({
        hypothesisId: 'H1-H2',
        location: 'scraper.js:post-credentials',
        message: 'Login page DOM: forms, radios, account-type hints',
        data: loginDiag,
      });
    }
    // #endregion

    console.log(
      `   ⏳ Waiting for reCAPTCHA to appear (up to ${Math.round(RECAPTCHA_WIDGET_TIMEOUT_MS / 1000)}s; override with AFFILIATLY_RECAPTCHA_LOAD_MS)...`
    );
    await waitForRecaptchaWidget(page, RECAPTCHA_WIDGET_TIMEOUT_MS);

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
      let captchaSolveAttempts = 0;

      // Try 2captcha if API key provided
      if (twoCaptchaKey) {
        console.log('\n🤖 reCAPTCHA detected - attempting auto-solve with 2captcha...');
        const solved = await solve2Captcha(page, twoCaptchaKey, {
          userAffiliateProgramId,
          loginUrlHint: loginUrl || '',
          email,
          password,
        });
        captchaSolveAttempts++;
        if (!solved) {
          console.log('   ⚠️ Auto-solve failed, falling back to manual...');
        }
      }

      // When 2captcha is available, let the retry logic below re-solve if the
      // first token was rejected. The reCAPTCHA widget text ("I'm not a robot")
      // stays in the DOM even after injecting a solved token, so checking it here
      // gives false positives that would throw before retries can run.
      if (!twoCaptchaKey && headless) {
        throw new Error('CAPTCHA detected but no TWOCAPTCHA_API_KEY configured. Cannot solve in headless mode.');
      }

      // Check if we already navigated away from login (2captcha may have succeeded)
      const isLoggedIn = () => page.evaluate(() => {
        return document.querySelector('input[type="password"]') === null;
      });

      let loggedIn = await isLoggedIn();

      if (loggedIn) {
        console.log('   ✅ 2captcha solved CAPTCHA and login succeeded!');
      } else if (twoCaptchaKey && captchaSolveAttempts > 0) {
        // Retry with fresh tokens — previous token may have been consumed/rejected
        for (let attempt = 2; attempt <= 4 && !loggedIn; attempt++) {
          console.log(`   🔁 Still on login page after CAPTCHA solve, re-solving (attempt ${attempt})...`);
          await solve2Captcha(page, twoCaptchaKey, {
            userAffiliateProgramId,
            loginUrlHint: loginUrl || '',
            email,
            password,
          });
          captchaSolveAttempts++;
          loggedIn = await isLoggedIn();
        }

        if (loggedIn) {
          console.log('   ✅ CAPTCHA retry succeeded!');
        } else if (headless) {
          throw new Error('CAPTCHA detected but auto-solve failed after multiple attempts in headless mode.');
        }
      }

      if (!loggedIn && !headless) {
        console.log('\n🤖 reCAPTCHA still present — manual solving may be needed.');
        console.log('   ⏸️  Please solve the CAPTCHA in the browser window...');
        console.log('   ⏳ Waiting up to 120 seconds...\n');

        let captchaSolved = false;
        let loginClickedAt = 0;

        for (let i = 0; i < 60; i++) {
          await sleep(2000);

          const stillOnLogin = await page.evaluate(() => {
            return document.querySelector('input[type="password"]') !== null;
          });

          if (!stillOnLogin) {
            captchaSolved = true;
            console.log('   ✅ CAPTCHA solved and login successful!');
            break;
          }

          const captchaState = await page.evaluate(() => {
            const textarea = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
            const hasToken = textarea && textarea.value && textarea.value.length > 20;
            const hasCheckmark = document.querySelector('.recaptcha-checkbox-checked') !== null;
            return { hasToken, hasCheckmark };
          });

          const looksActuallySolved = captchaState.hasToken || captchaState.hasCheckmark;

          if (looksActuallySolved && (i - loginClickedAt) >= 3) {
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

              const navigated = await page.evaluate(() => {
                return document.querySelector('input[type="password"]') === null;
              });

              if (navigated) {
                captchaSolved = true;
                console.log('   ✅ Login successful after CAPTCHA!');
                break;
              }

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

    // Check if login was successful (password field gone = dashboard loaded)
    let currentUrl = page.url();
    console.log(`   Current URL after login: ${currentUrl}`);

    const stillHasPasswordField = await page.evaluate(() =>
      document.querySelector('input[type="password"]') !== null
    );

    if (stillHasPasswordField) {
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

    // Step 6: Try "show all" first, then extract with pagination fallback
    await tryShowAllRecords(page);

    console.log('📄 Extracting commission data...');
    let commissions = await extractAllPages(page);

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
    const form =
      document.querySelector('form.login_form') ||
      document.querySelector('form.login') ||
      document.querySelector('form[action*="login"]') ||
      document.querySelector('form');

    // 1. Set all g-recaptcha-response textareas and fire DOM events
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

    // 1b. Google's textarea is usually outside <form.login>, so application/x-www-form-urlencoded POST omits it.
    //     Move it into the login form so $("form.login").submit() includes g-recaptcha-response (fixes server "Please use the Google reCaptcha").
    const primaryTa =
      document.querySelector('#g-recaptcha-response') ||
      document.querySelector('textarea[name="g-recaptcha-response"]');
    if (form && primaryTa && !form.contains(primaryTa)) {
      form.appendChild(primaryTa);
    }
    if (form) {
      const taInForm = form.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
      if (taInForm) {
        form.querySelectorAll('input[name="g-recaptcha-response"]').forEach((el) => el.remove());
      } else {
        let hid = form.querySelector('input[name="g-recaptcha-response"]');
        if (!hid) {
          hid = document.createElement('input');
          hid.type = 'hidden';
          hid.name = 'g-recaptcha-response';
          form.appendChild(hid);
        }
        hid.value = t;
      }
    }

    // 2. Patch grecaptcha (widget id is often passed as first arg)
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

    // 4. Walk ___grecaptcha_cfg.clients (nested objects + arrays; Google changes shape over time)
    try {
      const clients = window.___grecaptcha_cfg?.clients;
      if (clients) {
        const findCallback = (obj, depth) => {
          if (depth > 12 || obj == null) return null;
          if (typeof obj === 'function') return null;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const found = findCallback(item, depth + 1);
              if (found) return found;
            }
            return null;
          }
          if (typeof obj === 'object') {
            if (typeof obj.callback === 'function') return obj.callback;
            for (const key of Object.keys(obj)) {
              const val = obj[key];
              if (key === 'callback' && typeof val === 'function') return val;
              const found = findCallback(val, depth + 1);
              if (found) return found;
            }
          }
          return null;
        };

        for (const clientId of Object.keys(clients)) {
          const cb = findCallback(clients[clientId], 0);
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
 * Main-site `login.html?affiliates=1` uses `form.login` + `#login_into_account` with preventDefault →
 * AJAX `check_programs` → then `user_affiliate_program_id` + submit. Raw `form.submit()` skips that.
 */
async function pageHasMainAffiliatlyLoginForm(page) {
  return page.evaluate(
    () =>
      Boolean(
        document.querySelector('form.login') &&
          document.querySelector('#login_into_account') &&
          document.querySelector('[name="user_affiliate_program_id"]')
      )
  );
}

/**
 * Mirrors functions_two.js: POST check_programs then native form.submit() with program id set.
 * @param {{ userAffiliateProgramId?: string, loginUrlHint?: string }} opts
 */
async function submitAffiliatlyCheckProgramsThenForm(page, opts) {
  const { userAffiliateProgramId, loginUrlHint } = opts || {};
  const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null);
  const evalResult = await page.evaluate(
    async ({ preferredProgramId, panelUrlHint }) => {
      const form = document.querySelector('form.login');
      if (!form) return { ok: false, reason: 'no_form' };

      const email = form.querySelector('[name="email"]')?.value ?? '';
      const mode = form.querySelector('[name="login_mode"]')?.value ?? '';
      const hsf = form.querySelector('[name="login_hsf"]')?.value ?? '';

      const body = new URLSearchParams({
        login: '1',
        check_programs: '1',
        email,
        mode,
        hsf,
      });

      const res = await fetch(window.location.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'same-origin',
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, reason: 'bad_json', preview: text.slice(0, 200) };
      }

      if (data.error !== undefined) {
        return { ok: false, reason: 'ajax_error', error: String(data.error) };
      }

      const keys = Object.keys(data);
      if (keys.length === 0) {
        return { ok: false, reason: 'no_programs' };
      }

      let chosenId = null;
      const pref = (preferredProgramId || '').trim();
      if (keys.length === 1) {
        chosenId = data[keys[0]].id;
      } else if (pref) {
        for (const k of keys) {
          if (String(data[k].id) === pref) {
            chosenId = data[k].id;
            break;
          }
        }
        if (chosenId == null) {
          return { ok: false, reason: 'pref_not_found', count: keys.length };
        }
      } else {
        const m = (panelUrlHint || '').match(/\/af-(\d+)\//i);
        const af = m ? m[1] : null;
        if (af) {
          for (const k of keys) {
            const u = String(data[k].url || '');
            if (u.includes(`af-${af}`) || u.includes(`/${af}/`)) {
              chosenId = data[k].id;
              break;
            }
          }
        }
        if (chosenId == null) {
          return { ok: false, reason: 'multi_program', count: keys.length };
        }
      }

      const hid = form.querySelector('[name="user_affiliate_program_id"]');
      if (hid) hid.value = String(chosenId);
      form.submit();
      return { ok: true, submitted: true };
    },
    { preferredProgramId: userAffiliateProgramId || '', panelUrlHint: loginUrlHint || '' }
  );
  await navPromise;
  return evalResult;
}

/**
 * Solves reCAPTCHA using @2captcha/captcha-solver and injects token + submits login.
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string} apiKey - 2Captcha API key
 * @param {{ userAffiliateProgramId?: string, loginUrlHint?: string, email?: string, password?: string }} [options]
 * @returns {Promise<boolean>} True if solved successfully
 */
async function solve2Captcha(page, apiKey, options = {}) {
  const { userAffiliateProgramId, loginUrlHint, email, password } = options;
  try {
    if (email && password) {
      await page
        .waitForSelector(
          'input[name="password"], input[type="password"]',
          { timeout: 10000 }
        )
        .catch(() => {});
      await fillAffiliatlyCredentials(page, email, password);
      await sleep(300);
    }

    let sitekey = await page.evaluate(() => {
      const el = document.querySelector('.g-recaptcha, [data-sitekey]');
      return el?.getAttribute('data-sitekey') || null;
    });

    if (!sitekey) {
      console.log('   ⏳ No sitekey yet — waiting for widget again...');
      await waitForRecaptchaWidget(page, RECAPTCHA_WIDGET_TIMEOUT_MS);
      sitekey = await page.evaluate(() => {
        const el = document.querySelector('.g-recaptcha, [data-sitekey]');
        return el?.getAttribute('data-sitekey') || null;
      });
    }

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

    // #region agent log
    agentDebugLog({
      hypothesisId: 'H5',
      location: 'scraper.js:solve2Captcha',
      message: '2Captcha task context',
      data: {
        websiteURL,
        sitekeyLen: sitekey.length,
        sitekeyPrefix: sitekey.slice(0, 12),
        tokenLen: token.length,
      },
    });
    // #endregion

    const callbackInvoked = await injectRecaptchaToken(page, token);
    console.log(
      callbackInvoked
        ? '   ✅ reCAPTCHA site callback invoked'
        : '   ⚠️ No callback found, token set in textarea only'
    );

    // #region agent log
    {
      const snap = await page.evaluate(() => {
        const form = document.querySelector('form.login_form') || document.querySelector('form.login');
        const ta = document.querySelector('#g-recaptcha-response');
        return {
          textareaInLoginForm: !!(form && ta && form.contains(ta)),
          formFieldCount: form ? form.querySelectorAll('[name="g-recaptcha-response"]').length : 0,
        };
      });
      agentDebugLog({
        hypothesisId: 'POST-FIX',
        location: 'scraper.js:after-inject',
        message: 'g-recaptcha field associated with form.login',
        data: snap,
      });
    }
    // #endregion

    await sleep(1500);

    // Main site: click runs preventDefault → async check_programs → form.submit(). Register navigation
    // before the click so we don't miss the load (click-then-wait races and loses navigation).
    const loginBtnSelector =
      (await page.$('#login_into_account')) ? '#login_into_account' : await findSelector(page, [
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

    if (loginBtnSelector) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null),
        page.click(loginBtnSelector),
      ]);
      await sleep(1500);
    }

    let stillOnLogin = await page.evaluate(() => {
      return document.querySelector('input[type="password"]') !== null;
    });
    if (!stillOnLogin) {
      console.log('   ✅ Login submit succeeded after CAPTCHA solve');
      return true;
    }

    const hasMainSiteAffiliateForm = await pageHasMainAffiliatlyLoginForm(page);
    if (hasMainSiteAffiliateForm) {
      console.log('   🔁 Retrying main-site login via check_programs + submit (same as site JS)...');
      const cpResult = await submitAffiliatlyCheckProgramsThenForm(page, {
        userAffiliateProgramId,
        loginUrlHint,
      });
      await sleep(1500);
      stillOnLogin = await page.evaluate(() => document.querySelector('input[type="password"]') !== null);
      if (!stillOnLogin) {
        console.log('   ✅ Login submit succeeded after CAPTCHA solve');
        return true;
      }
      if (cpResult?.reason === 'multi_program') {
        console.log(
          `   ⚠️ Multiple affiliate programs (${cpResult.count}). Set AFFILIATLY_USER_AFFILIATE_PROGRAM_ID or AFFILIATLY_LOGIN_URL (e.g. …/af-106821/affiliate.panel).`
        );
      } else if (cpResult?.reason === 'no_programs') {
        console.log('   ⚠️ check_programs found no programs for this email on the generic affiliates login.');
      } else if (cpResult?.reason === 'ajax_error' && cpResult.error) {
        console.log(`   ⚠️ check_programs: ${cpResult.error}`);
      } else if (cpResult?.reason === 'pref_not_found') {
        console.log(
          `   ⚠️ AFFILIATLY_USER_AFFILIATE_PROGRAM_ID did not match any program (options: ${cpResult.count}).`
        );
      }
      // Do not native-submit form.login here — it POSTs without program id and shows "Wrong email and/or password".
    } else {
      // Store panel / other: synthetic submit + native submit
      console.log('   🔁 Dispatching submit event so form handler runs with token...');
      const submitEventDispatched = await page.evaluate(() => {
        const form = document.querySelector('form.login_form') || document.querySelector('form.login') || document.querySelector('form');
        const btn = document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]');
        if (form && btn) {
          const ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: btn });
          form.dispatchEvent(ev);
          return true;
        }
        return false;
      });
      if (submitEventDispatched) {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(2000);
        stillOnLogin = await page.evaluate(() => document.querySelector('input[type="password"]') !== null);
        if (!stillOnLogin) {
          console.log('   ✅ Submit event triggered login');
          return true;
        }
      }

      console.log('   🔁 Trying native form.submit()...');
      const formSubmitted = await page.evaluate(() => {
        const form = document.querySelector('form.login_form') || document.querySelector('form.login') || document.querySelector('form');
        if (form) {
          form.submit();
          return true;
        }
        return false;
      });
      if (formSubmitted) {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await sleep(2000);
      }

      stillOnLogin = await page.evaluate(() => document.querySelector('input[type="password"]') !== null);
      if (!stillOnLogin) {
        console.log('   ✅ form.submit() succeeded after CAPTCHA solve');
      } else {
        console.log('   ⚠️ Still on login page after CAPTCHA solve + form submit');
      }
    }

    // #region agent log
    {
      const postFail = await page.evaluate(() => {
        const errEls = [...document.querySelectorAll('.error, .alert-danger, .alert, .login-error, [class*="error"]')];
        const errors = errEls.map((e) => (e.textContent || '').trim().slice(0, 300)).filter(Boolean);
        const forms = [...document.querySelectorAll('form')].map((f, i) => ({
          i,
          action: (f.action || '').slice(0, 120),
        }));
        return {
          href: location.href,
          title: document.title,
          hasPasswordField: document.querySelector('input[type="password"]') !== null,
          errors,
          forms,
        };
      });
      agentDebugLog({
        hypothesisId: 'H3-H4',
        location: 'scraper.js:solve2Captcha:after-submit',
        message: 'After CAPTCHA strategies: URL, errors, forms',
        data: {
          pageUrl: page.url(),
          stillOnLogin,
          callbackInvoked,
          ...postFail,
        },
      });
    }
    // #endregion

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
 * Attempts to load all records via "show all" or rows-per-page adjustment.
 * Returns true if all records are now visible on a single page (no pagination needed).
 */
async function tryShowAllRecords(page) {
  console.log('📄 Attempting to show all records on one page...');

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
    return true;
  }

  return false;
}

/**
 * Extracts records from the current page, then paginates through all remaining
 * pages, accumulating records from each one.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @returns {Promise<Array>} All records across every page
 */
async function extractAllPages(page) {
  const allRecords = [];
  let pageNum = 1;

  // Extract from the first (current) page
  let records = await extractFromDOM(page);
  allRecords.push(...records);
  console.log(`   📄 Page ${pageNum}: ${records.length} records`);

  let hasMore = true;
  while (hasMore && pageNum < 50) {
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

    if (!nextResult.found) {
      hasMore = false;
      break;
    }

    pageNum++;
    await sleep(2000);
    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});

    const afterHash = await page.evaluate(() => document.body.innerText.length + '|' + document.body.innerText.slice(0, 500));
    if (afterHash === beforeHash) {
      console.log(`   ℹ️ Page content unchanged — no more pages.`);
      hasMore = false;
      break;
    }

    records = await extractFromDOM(page);
    allRecords.push(...records);
    console.log(`   📄 Page ${pageNum}: ${records.length} records`);
  }

  if (pageNum > 1) {
    console.log(`   ✅ Collected records from ${pageNum} pages`);
  }

  return allRecords;
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
    await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('🔍 Browser opened for debugging.');
    console.log('   Log in manually and navigate to the Commissions page.');
    console.log('   Watch the console for API calls.');
    console.log('   Press Ctrl+C to close.');
    await new Promise(() => {});
  } catch (error) {
    console.error('Debug session error:', error);
  }
}
