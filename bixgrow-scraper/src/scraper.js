import puppeteer from 'puppeteer';
import { execSync } from 'child_process';

const LOGIN_URL = 'https://affiliate.joola.com/login';
const COMMISSIONS_URL = 'https://affiliate.joola.com/commissions';

/** Simple sleep helper */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Find system Chrome on macOS (Puppeteer's bundled Chrome has compatibility issues)
 */
function findSystemChrome() {
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
 * Scrapes commission data from BixGrow affiliate dashboard.
 * Uses network interception to capture API responses for cleaner data extraction.
 *
 * @param {Object} options - Scraper options
 * @param {string} options.email - BixGrow login email
 * @param {string} options.password - BixGrow login password
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @param {string} [options.startDate] - Filter start date (YYYY-MM-DD)
 * @param {string} [options.endDate] - Filter end date (YYYY-MM-DD)
 * @returns {Promise<Array>} Array of commission/transaction objects
 */
export async function scrapeCommissions({ email, password, headless = true, startDate, endDate }) {
  console.log('🚀 Starting BixGrow scraper...');
  console.log(`   Headless: ${headless}`);

  const executablePath = findSystemChrome();
  if (executablePath) {
    console.log(`🌐 Using system Chrome: ${executablePath}`);
  }

  let browser;
  try {
    console.log('🌐 Launching browser...');
    browser = await puppeteer.launch({
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
  } catch (launchError) {
    console.error('❌ Failed to launch browser:', launchError.message);
    throw launchError;
  }

  const page = await browser.newPage();

  // Set a realistic user agent to avoid bot detection
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Hide webdriver property
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Store intercepted API responses and auth token
  const apiResponses = [];
  let authToken = null;

  // Set up network interception to capture commission data from API calls
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    request.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';

    // Log all API calls for debugging
    if (url.includes('/api/')) {
      console.log(`📡 API: ${response.request().method()} ${url.split('?')[0]} [${response.status()}]`);
    }

    // Capture ALL JSON API responses to help debug what endpoints exist
    if (contentType.includes('application/json') && url.includes('/api/')) {
      try {
        const text = await response.text();
        const data = JSON.parse(text);

        // Log a preview of every API response
        const preview = JSON.stringify(data).slice(0, 150);
        console.log(`  └─ ${preview}${preview.length >= 150 ? '...' : ''}`);

        // Capture auth token from login response
        if (url.includes('/login') && data.token) {
          authToken = data.token;
          console.log(`  └─ 🔑 Captured auth token`);
        }

        // Extract the actual data array - handle nested structures like { data: { data: [...] } }
        let records = null;
        if (data.data?.data && Array.isArray(data.data.data)) {
          records = data.data.data;  // Nested: { data: { data: [...] } }
        } else if (Array.isArray(data.data)) {
          records = data.data;  // Direct: { data: [...] }
        }

        // Capture responses that look like commission/conversion data
        if (records && records.length > 0 && url.includes('conversion')) {
          console.log(`  └─ 💾 CAPTURED: ${records.length} records from conversions API`);
          apiResponses.push({ url, data, records });
        }
      } catch (e) {
        // Response body already consumed or not JSON
      }
    }
  });

  try {
    // Step 1: Navigate to login page
    console.log('📍 Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the SPA to render the login form
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', {
      timeout: 15000
    });

    // Step 2: Fill in login credentials
    console.log('🔐 Entering credentials...');

    // Try different possible selectors for email field
    const emailSelector = await findSelector(page, [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      'input[id*="email" i]',
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

    // Step 3: Submit login form
    console.log('🔑 Submitting login...');

    // Find and click login button
    const loginButtonSelector = await findSelector(page, [
      'button[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'input[type="submit"]',
      '.login-btn',
      '#login-btn',
    ]);

    if (loginButtonSelector) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.click(loginButtonSelector),
      ]);
    } else {
      // Try pressing Enter as fallback
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.keyboard.press('Enter'),
      ]);
    }

    // Step 4: Navigate to commissions page
    console.log('📊 Navigating to commissions page...');

    // Wait for dashboard to load after login
    await sleep(2000);

    // Try clicking the Commissions link in the nav menu
    const commissionsLinkClicked = await page.evaluate(() => {
      // Look for a link containing "Commissions" text
      const links = Array.from(document.querySelectorAll('a'));
      const commissionsLink = links.find(a => a.textContent.trim() === 'Commissions');
      if (commissionsLink) {
        commissionsLink.click();
        return true;
      }
      return false;
    });

    if (commissionsLinkClicked) {
      console.log('   ✅ Clicked Commissions link');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    } else {
      console.log('   ⚠️ Could not find Commissions link, trying direct URL...');
      await page.goto(COMMISSIONS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    }

    // Wait for the page to load data
    console.log('⏳ Waiting for page data to load...');
    await sleep(5000);

    // Log current URL
    console.log(`   Current URL: ${page.url()}`);

    // Try scrolling to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    // Step 5: Apply date filters if provided
    if (startDate || endDate) {
      console.log(`📅 Applying date filter: ${startDate || 'start'} to ${endDate || 'end'}`);
      await applyDateFilter(page, startDate, endDate);
    }

    // Step 6: Extract data - try API interception first, fall back to DOM parsing
    let commissions = [];

    console.log(`\n📊 API responses captured: ${apiResponses.length}`);

    if (apiResponses.length > 0) {
      console.log('✅ Using intercepted API data');
      commissions = extractFromApiResponses(apiResponses);

      // Debug: log first raw record's fields
      if (commissions.length > 0 && process.env.DEBUG) {
        console.log('\n📋 Raw API record fields:', Object.keys(commissions[0]).join(', '));
        console.log('📋 Sample raw record:', JSON.stringify(commissions[0], null, 2));
      }
    }

    // Get auth token from localStorage if not captured from response
    if (!authToken) {
      authToken = await page.evaluate(() => {
        return localStorage.getItem('token') ||
               localStorage.getItem('auth_token') ||
               localStorage.getItem('access_token') ||
               sessionStorage.getItem('token');
      });
    }

    // Fetch ALL pages of commission data via direct API calls
    console.log('\n📄 Fetching all pages of commission data...');
    const allCommissions = await fetchAllCommissions(page, authToken);
    if (allCommissions.length > 0) {
      commissions = allCommissions;
    }

    // Always try DOM parsing if we don't have enough data
    if (commissions.length === 0) {
      console.log('📄 Trying DOM parsing...');
      commissions = await extractFromDOM(page);

      if (commissions.length === 0) {
        // Take a screenshot and dump page info for debugging
        console.log('⚠️ No data found. Taking debug screenshot...');
        await page.screenshot({ path: 'debug-commissions-page.png', fullPage: true });

        // Log page URL and title
        console.log(`   Current URL: ${page.url()}`);
        console.log(`   Page title: ${await page.title()}`);

        // Check what elements exist on the page
        const pageInfo = await page.evaluate(() => {
          const tables = document.querySelectorAll('table');
          const divWithData = document.querySelectorAll('[class*="table"], [class*="data"], [class*="list"], [class*="grid"]');
          return {
            tableCount: tables.length,
            dataElements: divWithData.length,
            bodyText: document.body.innerText.slice(0, 500),
          };
        });
        console.log(`   Tables found: ${pageInfo.tableCount}`);
        console.log(`   Data-like elements: ${pageInfo.dataElements}`);
        console.log(`   Page text preview: ${pageInfo.bodyText.slice(0, 200)}...`);
      }
    }

    console.log(`✅ Scraped ${commissions.length} commission records`);

    return commissions;

  } catch (error) {
    console.error('❌ Scraping failed:', error.message);

    // Take a screenshot for debugging
    const screenshotPath = `error-screenshot-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 Error screenshot saved to: ${screenshotPath}`);

    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Fetches all commission records by paginating through the API
 * Extracts cookies from browser and makes requests from Node.js to avoid CORS
 *
 * API params:
 * - page: page number
 * - paginate: items per page
 * - sort_direction: 'asc' or 'desc'
 * - sort_field: 'created_at', etc.
 * - start_date: Unix timestamp
 * - end_date: Unix timestamp
 */
async function fetchAllCommissions(page, authToken) {
  const API_BASE = 'https://api.bixgrow.com/api/partner/conversions';
  const allRecords = [];
  let currentPage = 1;
  let lastPage = 1;
  const perPage = 100;

  // Use "all-time" date range: from Jan 1, 2020 to now
  const startDate = Math.floor(new Date('2020-01-01').getTime() / 1000);
  const endDate = Math.floor(Date.now() / 1000);

  // Get cookies from the browser session
  const cookies = await page.cookies();
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  if (authToken) {
    console.log('   🔑 Using auth token for API requests');
  }

  console.log('   📥 Fetching all commission pages (all-time)...');

  do {
    try {
      const apiUrl = `${API_BASE}?page=${currentPage}&paginate=${perPage}&sort_direction=desc&sort_field=created_at&start_date=${startDate}&end_date=${endDate}`;

      // Build headers with auth token if available
      const headers = {
        'Accept': 'application/json',
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      };

      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      // Make API request from Node.js
      const res = await fetch(apiUrl, { headers });

      const response = await res.json();

      if (response.status === 'Success' && response.data) {
        const pageData = response.data;
        const records = pageData.data || [];

        if (records.length > 0) {
          allRecords.push(...records);
        }

        // Get pagination info
        lastPage = pageData.last_page || 1;
        const total = pageData.total || records.length;

        console.log(`   📄 Page ${currentPage}/${lastPage}: ${records.length} records (${allRecords.length}/${total} total)`);

        currentPage++;
      } else {
        console.warn('   ⚠️ Unexpected API response:', response.message || 'Unknown error');
        break;
      }
    } catch (error) {
      console.error(`   ❌ Error fetching page ${currentPage}:`, error.message);
      break;
    }
  } while (currentPage <= lastPage);

  console.log(`   ✅ Fetched ${allRecords.length} total commission records`);
  return allRecords;
}

/**
 * Finds the first matching selector from a list of possible selectors
 */
async function findSelector(page, selectors) {
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
 * Applies date filter on the commissions page
 */
async function applyDateFilter(page, startDate, endDate) {
  // Look for date picker elements
  const datePickerSelectors = [
    'input[type="date"]',
    '.date-picker',
    '.date-range-picker',
    '[data-testid="date-picker"]',
    'input[placeholder*="date" i]',
  ];

  // This will need to be customized based on BixGrow's actual UI
  // For now, we'll try common patterns
  try {
    const dateInputs = await page.$$('input[type="date"], .date-input');
    if (dateInputs.length >= 2) {
      if (startDate) {
        await dateInputs[0].type(startDate);
      }
      if (endDate) {
        await dateInputs[1].type(endDate);
      }

      // Look for apply/filter button
      const applyButton = await findSelector(page, [
        'button:has-text("Apply")',
        'button:has-text("Filter")',
        'button:has-text("Search")',
        '.apply-btn',
        '.filter-btn',
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

  for (const { url, data, records } of apiResponses) {
    // Use pre-extracted records if available
    if (records && Array.isArray(records)) {
      commissions.push(...records);
      continue;
    }

    // Handle different possible API response structures
    const extracted = data.data?.data || data.data || data.commissions || data.conversions ||
                    data.transactions || data.records || data.items ||
                    (Array.isArray(data) ? data : []);

    if (Array.isArray(extracted)) {
      commissions.push(...extracted);
    }
  }

  return commissions;
}

/**
 * Extracts commission data by parsing the DOM table
 * Fallback method when API interception doesn't capture data
 */
async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const commissions = [];

    // Try to find the data table
    const table = document.querySelector('table, .data-table, .commissions-table, [role="table"]');

    if (!table) {
      console.warn('No table found on page');
      return commissions;
    }

    // Get headers
    const headerRow = table.querySelector('thead tr, tr:first-child');
    const headers = [];
    if (headerRow) {
      headerRow.querySelectorAll('th, td').forEach(cell => {
        headers.push(cell.textContent.trim().toLowerCase().replace(/\s+/g, '_'));
      });
    }

    // Get data rows
    const rows = table.querySelectorAll('tbody tr, tr:not(:first-child)');

    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length === 0) return;

      const record = {};
      cells.forEach((cell, index) => {
        const header = headers[index] || `column_${index}`;
        record[header] = cell.textContent.trim();
      });

      commissions.push(record);
    });

    return commissions;
  });
}

/**
 * Debug function to explore the page structure
 * Useful for understanding BixGrow's UI
 */
export async function debugPageStructure({ email, password }) {
  const executablePath = findSystemChrome();
  if (executablePath) {
    console.log(`🌐 Using system Chrome: ${executablePath}`);
  }

  const browser = await puppeteer.launch({
    headless: false, // Always show browser for debugging
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const page = await browser.newPage();

  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Hide webdriver property
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Log all network requests
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/')) {
      console.log(`API Call: ${response.request().method()} ${url} - ${response.status()}`);
      try {
        const data = await response.json();
        console.log('Response:', JSON.stringify(data, null, 2).slice(0, 500));
      } catch (e) {
        // Not JSON
      }
    }
  });

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for manual inspection
    console.log('🔍 Browser opened for debugging. Press Ctrl+C to close.');
    await new Promise(() => {}); // Keep browser open indefinitely

  } catch (error) {
    console.error('Debug session error:', error);
  }
}

