import {
  sleep,
  findSelector,
  launchBrowser,
  createStealthPage,
  setupNetworkInterception,
  getCookieString,
} from '@kitchen/shared/scraper-base';

const LOGIN_URL = 'https://affiliate.joola.com/login';
const COMMISSIONS_URL = 'https://affiliate.joola.com/commissions';

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
  let authToken = null;

  // Set up network interception to capture commission data from API calls
  await setupNetworkInterception(page, {
    onApiResponse: ({ url, data }) => {
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
    },
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
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
        page.keyboard.press('Enter'),
      ]);
    }

    // Step 4: Navigate to commissions page
    console.log('📊 Navigating to commissions page...');
    await sleep(2000);

    const commissionsLinkClicked = await page.evaluate(() => {
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
    const fetchResult = await fetchAllCommissions(page, authToken);
    const allCommissions = fetchResult.records;
    const platformTotalCount = fetchResult.platformTotal;
    if (allCommissions.length > 0) {
      commissions = allCommissions;
    }

    // Always try DOM parsing if we don't have enough data
    if (commissions.length === 0) {
      console.log('📄 Trying DOM parsing...');
      commissions = await extractFromDOM(page);

      if (commissions.length === 0) {
        console.log('⚠️ No data found. Taking debug screenshot...');
        await page.screenshot({ path: 'debug-commissions-page.png', fullPage: true });
        console.log(`   Current URL: ${page.url()}`);
        console.log(`   Page title: ${await page.title()}`);
      }
    }

    console.log(`✅ Scraped ${commissions.length} commission records`);

    return { records: commissions, aggregate: { platformCount: platformTotalCount } };

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
 * Fetches all commission records by paginating through the API
 */
async function fetchAllCommissions(page, authToken) {
  const API_BASE = 'https://api.bixgrow.com/api/partner/conversions';
  const allRecords = [];
  let currentPage = 1;
  let lastPage = 1;
  let platformTotal = null; // platform-reported total record count for the audit
  const perPage = 100;

  // Use "all-time" date range: from Jan 1, 2020 to now
  const startDate = Math.floor(new Date('2020-01-01').getTime() / 1000);
  const endDate = Math.floor(Date.now() / 1000);

  const cookieString = await getCookieString(page);

  if (authToken) {
    console.log('   🔑 Using auth token for API requests');
  }

  console.log('   📥 Fetching all commission pages (all-time)...');

  do {
    try {
      const apiUrl = `${API_BASE}?page=${currentPage}&paginate=${perPage}&sort_direction=desc&sort_field=created_at&start_date=${startDate}&end_date=${endDate}`;

      const headers = {
        'Accept': 'application/json',
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      };

      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const res = await fetch(apiUrl, { headers });
      const response = await res.json();

      if (response.status === 'Success' && response.data) {
        const pageData = response.data;
        const records = pageData.data || [];

        if (records.length > 0) {
          allRecords.push(...records);
        }

        lastPage = pageData.last_page || 1;
        const total = pageData.total || records.length;
        if (Number.isFinite(pageData.total)) platformTotal = pageData.total;

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

  console.log(`   ✅ Fetched ${allRecords.length} total commission records${platformTotal != null ? ` (platform reports ${platformTotal})` : ''}`);
  return { records: allRecords, platformTotal };
}

/**
 * Applies date filter on the commissions page
 */
async function applyDateFilter(page, startDate, endDate) {
  try {
    const dateInputs = await page.$$('input[type="date"], .date-input');
    if (dateInputs.length >= 2) {
      if (startDate) {
        await dateInputs[0].type(startDate);
      }
      if (endDate) {
        await dateInputs[1].type(endDate);
      }

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
    if (records && Array.isArray(records)) {
      commissions.push(...records);
      continue;
    }

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
 */
async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const commissions = [];

    const table = document.querySelector('table, .data-table, .commissions-table, [role="table"]');

    if (!table) {
      console.warn('No table found on page');
      return commissions;
    }

    const headerRow = table.querySelector('thead tr, tr:first-child');
    const headers = [];
    if (headerRow) {
      headerRow.querySelectorAll('th, td').forEach(cell => {
        headers.push(cell.textContent.trim().toLowerCase().replace(/\s+/g, '_'));
      });
    }

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
 */
export async function debugPageStructure({ email, password }) {
  const browser = await launchBrowser({ headless: false });
  const page = await createStealthPage(browser);

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
    console.log('🔍 Browser opened for debugging. Press Ctrl+C to close.');
    await new Promise(() => {});
  } catch (error) {
    console.error('Debug session error:', error);
  }
}

