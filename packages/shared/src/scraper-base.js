import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

/** Simple sleep helper */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Find system Chrome on macOS (Puppeteer's bundled Chrome has compatibility issues)
 */
export function findSystemChrome() {
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  for (const p of chromePaths) {
    try {
      execSync(`test -f "${p}"`, { stdio: 'ignore' });
      return p;
    } catch (e) {
      // Not found, try next
    }
  }
  return undefined; // Fall back to Puppeteer's bundled Chrome
}

/**
 * Finds the first matching selector from a list of possible selectors
 */
export async function findSelector(page, selectors) {
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        return selector;
      }
    } catch (e) {
      // Selector not found, try next
    }
  }
  return null;
}

/**
 * Launches a Puppeteer browser with common anti-detection settings
 * @param {Object} options - Launch options
 * @param {boolean} [options.headless=true] - Run in headless mode
 * @returns {Promise<Browser>} Puppeteer browser instance
 */
export async function launchBrowser({ headless = true } = {}) {
  const executablePath = findSystemChrome();
  if (executablePath) {
    console.log(`🌐 Using system Chrome: ${executablePath}`);
  }

  const browser = await puppeteer.launch({
    headless: headless ? 'new' : false,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
    defaultViewport: { width: 1920, height: 1080 },
    protocolTimeout: 60000,
  });

  console.log('✅ Browser launched successfully');
  return browser;
}

/**
 * Creates a new page with anti-detection settings
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<Page>} Configured page
 */
export async function createStealthPage(browser) {
  const page = await browser.newPage();

  // Set a realistic user agent to avoid bot detection
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Hide webdriver property
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return page;
}

/**
 * Sets up network interception on a page
 * @param {Page} page - Puppeteer page
 * @param {Object} options - Options
 * @param {Function} [options.onApiResponse] - Callback for API responses
 * @param {string} [options.apiPathMatch='/api/'] - Path to match for API calls
 */
export async function setupNetworkInterception(page, { onApiResponse, apiPathMatch = '/api/' } = {}) {
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    request.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    // Log all API calls for debugging
    if (url.includes(apiPathMatch)) {
      console.log(`📡 API: ${response.request().method()} ${url.split('?')[0]} [${response.status()}]`);
    }

    // Capture JSON API responses
    if (contentType.includes('application/json') && url.includes(apiPathMatch)) {
      try {
        const text = await response.text();
        const data = JSON.parse(text);

        // Log a preview of every API response
        const preview = JSON.stringify(data).slice(0, 150);
        console.log(`  └─ ${preview}${preview.length >= 150 ? '...' : ''}`);

        if (onApiResponse) {
          onApiResponse({ url, data, response });
        }
      } catch (e) {
        // Response body already consumed or not JSON
      }
    }
  });
}

/**
 * Extracts cookies from page for API requests
 * @param {Page} page - Puppeteer page
 * @returns {Promise<string>} Cookie string for requests
 */
export async function getCookieString(page) {
  const cookies = await page.cookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Gets auth token from page storage
 * @param {Page} page - Puppeteer page
 * @returns {Promise<string|null>} Auth token if found
 */
export async function getAuthToken(page) {
  return await page.evaluate(() => {
    return localStorage.getItem('token') ||
           localStorage.getItem('auth_token') ||
           localStorage.getItem('access_token') ||
           sessionStorage.getItem('token');
  });
}

