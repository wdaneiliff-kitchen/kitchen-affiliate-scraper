import {
  sleep,
  findSelector,
  launchBrowser,
  createStealthPage,
  setupNetworkInterception,
  getCookieString,
  getAuthToken,
} from '@kitchen/shared/scraper-base';

const LOGIN_URL = 'https://affiliates.socialsnowball.io/affiliate/login';
const PAYOUTS_URL = 'https://affiliates.socialsnowball.io/affiliate/dashboard/payouts/unpaid?page=1';

/**
 * Scrapes payout data from SocialSnowball affiliate dashboard.
 * Uses network interception to capture API responses for cleaner data extraction.
 *
 * @param {Object} options - Scraper options
 * @param {string} options.email - SocialSnowball login email
 * @param {string} options.password - SocialSnowball login password
 * @param {string} options.merchantName - Merchant name to select in dropdown
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @returns {Promise<Array>} Array of payout/commission objects
 */
export async function scrapePayouts({ email, password, merchantName, headless = true }) {
  console.log('🚀 Starting SocialSnowball scraper...');
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

  // Set up network interception
  await setupNetworkInterception(page, {
    onApiResponse: ({ url, data }) => {
      // Capture auth token from various possible locations
      if (data.token || data.access_token || data.accessToken) {
        authToken = data.token || data.access_token || data.accessToken;
        console.log(`  └─ 🔑 Captured auth token`);
      }

      // Try to identify payout/commission data responses
      let records = null;

      // Handle various possible response structures
      // SocialSnowball uses { payload: [...] } structure
      if (data.payload && Array.isArray(data.payload)) {
        records = data.payload;
      } else if (data.data?.data && Array.isArray(data.data.data)) {
        records = data.data.data;  // Nested: { data: { data: [...] } }
      } else if (Array.isArray(data.data)) {
        records = data.data;  // Direct: { data: [...] }
      } else if (data.payouts && Array.isArray(data.payouts)) {
        records = data.payouts;
      } else if (data.commissions && Array.isArray(data.commissions)) {
        records = data.commissions;
      } else if (Array.isArray(data)) {
        records = data;
      }

      // Capture responses that look like payout data
      // Prioritize specific payout endpoints, exclude notifications
      const urlLower = url.toLowerCase();
      const isPayoutEndpoint =
        urlLower.includes('payouts/pending') ||
        urlLower.includes('payouts/paid') ||
        urlLower.includes('search-payables') ||
        urlLower.includes('payables');

      // Exclude notification endpoints
      const isExcluded = urlLower.includes('notification');

      // Capture payout endpoint responses (even empty ones - means no pending payouts)
      if (records && isPayoutEndpoint && !isExcluded) {
        console.log(`  └─ 💾 CAPTURED: ${records.length} records from ${url.split('?')[0]}`);
        apiResponses.push({ url, data, records });
      }
    },
  });

  try {
    // Step 1: Navigate to login page
    console.log('📍 Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the login form to render
    await page.waitForSelector('input[type="email"], input[placeholder*="email" i], input[name="email"]', {
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
      'button:has-text("Sign in")',
      'button:has-text("Login")',
      'button:has-text("Log in")',
      'input[type="submit"]',
    ]);

    if (loginButtonSelector) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
        page.click(loginButtonSelector),
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
        page.keyboard.press('Enter'),
      ]);
    }

    // Wait for login to complete
    await sleep(3000);

    // Check if login was successful by looking for dashboard elements
    let currentUrl = page.url();
    console.log(`   Current URL after login: ${currentUrl}`);

    if (currentUrl.includes('login')) {
      throw new Error('Login failed - still on login page. Check credentials.');
    }

    // Step 4: Handle merchant selection if present (React Select dropdown)
    const hasMerchantSelection = await page.evaluate(() => {
      return document.body.innerText.includes('Choose a merchant');
    });

    if (hasMerchantSelection) {
      console.log(`🏪 Selecting merchant: ${merchantName}`);

      // Click on the React Select control to open the dropdown
      await page.click('.selectpicker__control');
      await sleep(500);

      // Type the merchant name to filter/search
      await page.type('.selectpicker__input', merchantName, { delay: 50 });
      await sleep(1000);

      // Press Enter to select the first matching option, or click the option
      const optionSelected = await page.evaluate((name) => {
        // Look for the option in the dropdown menu
        const options = document.querySelectorAll('.selectpicker__option, [class*="option"]');
        for (const option of options) {
          if (option.textContent.toLowerCase().includes(name.toLowerCase())) {
            option.click();
            return true;
          }
        }
        return false;
      }, merchantName);

      if (!optionSelected) {
        // Fallback: press Enter to select first match
        await page.keyboard.press('Enter');
      }

      console.log(`   ✅ Selected merchant: ${merchantName}`);
      await sleep(1000);

      // Click the "Enter dashboard" button
      const enterButton = await page.$('button[type="submit"]');
      if (enterButton) {
        const isDisabled = await page.evaluate(btn => btn.disabled, enterButton);
        if (!isDisabled) {
          console.log('   📥 Clicking "Enter dashboard" button...');
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            enterButton.click(),
          ]);
        } else {
          console.log('   ⚠️ Button still disabled, trying Enter key...');
          await page.keyboard.press('Enter');
          await sleep(3000);
        }
      }

      currentUrl = page.url();
      console.log(`   Current URL after merchant selection: ${currentUrl}`);
    }

    // Step 6: Navigate to Payouts page
    console.log('📊 Navigating to Payouts page...');

    // Try clicking the Payouts link in navigation first
    const payoutsLinkClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const payoutsLink = links.find(a =>
        a.textContent.trim().toLowerCase().includes('payout') ||
        a.href?.includes('payout')
      );
      if (payoutsLink) {
        payoutsLink.click();
        return true;
      }
      return false;
    });

    if (payoutsLinkClicked) {
      console.log('   ✅ Clicked Payouts link');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    } else {
      console.log('   ⚠️ Could not find Payouts link, navigating directly...');
      await page.goto(PAYOUTS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    }

    // Wait for the page to load data (Unpaid tab loads by default)
    console.log('⏳ Waiting for Unpaid tab data to load...');
    await sleep(5000);

    console.log(`   Current URL: ${page.url()}`);

    // Try scrolling to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    // Now click on the "Paid" tab to also capture paid payouts
    console.log('📊 Clicking on Paid tab to capture paid payouts...');
    const paidTabClicked = await page.evaluate(() => {
      // Look for the Paid tab/link
      const tabs = Array.from(document.querySelectorAll('a, button, [role="tab"]'));
      const paidTab = tabs.find(el => {
        const text = el.textContent.trim().toLowerCase();
        return text === 'paid' || text.includes('paid payout');
      });
      if (paidTab) {
        paidTab.click();
        return true;
      }
      return false;
    });

    if (paidTabClicked) {
      console.log('   ✅ Clicked Paid tab');
      await sleep(5000); // Wait for paid data to load
    } else {
      console.log('   ⚠️ Could not find Paid tab');
    }

    // Take a screenshot to debug the page structure
    await page.screenshot({ path: 'socialsnowball-payouts-page.png', fullPage: true });
    console.log('   📸 Saved debug screenshot: socialsnowball-payouts-page.png');

    // Step 5: Extract data
    let payouts = [];

    console.log(`\n📊 API responses captured: ${apiResponses.length}`);

    if (apiResponses.length > 0) {
      console.log('✅ Using intercepted API data');
      payouts = extractFromApiResponses(apiResponses);

      // Debug: log first record's fields
      if (payouts.length > 0) {
        console.log('\n📋 First record fields:', Object.keys(payouts[0]).join(', '));
        if (process.env.DEBUG) {
          console.log('📋 Sample raw record:', JSON.stringify(payouts[0], null, 2));
        }
      }
    }

    // Get auth token from localStorage if not captured
    if (!authToken) {
      authToken = await getAuthToken(page);
    }

    // Try to fetch more data via pagination if we have an auth token
    if (authToken || apiResponses.length > 0) {
      console.log('\n📄 Attempting to fetch all pages...');
      const allPayouts = await fetchAllPayouts(page, authToken, apiResponses);
      if (allPayouts.length > 0) {
        payouts = allPayouts;
      }
    }

    // Fall back to DOM parsing ONLY if we didn't get any API response
    // (If API returned empty array, that's valid - no pending payouts)
    if (payouts.length === 0 && apiResponses.length === 0) {
      console.log('📄 Trying DOM parsing (no API data captured)...');
      payouts = await extractFromDOM(page);

      if (payouts.length === 0) {
        console.log('⚠️ No data found.');
        console.log(`   Current URL: ${page.url()}`);
        console.log(`   Page title: ${await page.title()}`);

        // Log page structure for debugging
        const pageInfo = await page.evaluate(() => {
          const tables = document.querySelectorAll('table');
          const dataElements = document.querySelectorAll('[class*="table"], [class*="data"], [class*="list"]');
          return {
            tableCount: tables.length,
            dataElements: dataElements.length,
            bodyText: document.body.innerText.slice(0, 1000),
          };
        });
        console.log(`   Tables found: ${pageInfo.tableCount}`);
        console.log(`   Data-like elements: ${pageInfo.dataElements}`);
        console.log(`   Page text preview:\n${pageInfo.bodyText.slice(0, 500)}...`);
      }
    } else if (payouts.length === 0 && apiResponses.length > 0) {
      console.log('ℹ️  API returned 0 records - no pending payouts for this account');
    }

    console.log(`\n✅ Scraped ${payouts.length} payout records`);

    return payouts;

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
 * Attempts to fetch all payout records by paginating through the API
 * This is a discovery function - it will try to find the API endpoint pattern
 */
async function fetchAllPayouts(page, authToken, capturedResponses) {
  const allRecords = [];

  // If we captured API responses, try to determine the endpoint pattern
  if (capturedResponses.length > 0) {
    const { url, records } = capturedResponses[0];
    allRecords.push(...records);

    // Try to extract the base API URL and pagination pattern
    const baseUrl = url.split('?')[0];
    console.log(`   📡 Detected API endpoint: ${baseUrl}`);

    // Try fetching more pages
    const cookieString = await getCookieString(page);
    let currentPage = 2;
    let hasMore = true;

    while (hasMore && currentPage <= 50) {  // Safety limit
      try {
        const paginatedUrl = `${baseUrl}?page=${currentPage}`;

        const headers = {
          'Accept': 'application/json',
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        };

        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }

        const res = await fetch(paginatedUrl, { headers });

        if (!res.ok) {
          console.log(`   ⚠️ Page ${currentPage} returned ${res.status}, stopping pagination`);
          break;
        }

        const data = await res.json();

        // Extract records from response
        let pageRecords = null;
        if (data.data?.data && Array.isArray(data.data.data)) {
          pageRecords = data.data.data;
        } else if (Array.isArray(data.data)) {
          pageRecords = data.data;
        } else if (data.payouts && Array.isArray(data.payouts)) {
          pageRecords = data.payouts;
        } else if (Array.isArray(data)) {
          pageRecords = data;
        }

        if (pageRecords && pageRecords.length > 0) {
          allRecords.push(...pageRecords);
          console.log(`   📄 Page ${currentPage}: ${pageRecords.length} records (${allRecords.length} total)`);
          currentPage++;
        } else {
          hasMore = false;
        }
      } catch (error) {
        console.log(`   ⚠️ Error fetching page ${currentPage}: ${error.message}`);
        break;
      }
    }
  }

  return allRecords;
}

/**
 * Extracts payout data from intercepted API responses
 * - Tags records from paid endpoint with _status: 'paid'
 * - Flattens grouped payouts into individual order records
 */
function extractFromApiResponses(apiResponses) {
  const payouts = [];

  for (const { url, records } of apiResponses) {
    if (records && Array.isArray(records)) {
      // Check if this is from the paid endpoint
      const isPaidEndpoint = url.toLowerCase().includes('payouts/paid');

      for (const record of records) {
        // Check if this is a grouped payout with individual orders
        if (record.is_grouped && record.group && Array.isArray(record.group) && record.group.length > 0) {
          // Flatten: extract each individual order from the group
          console.log(`  └─ 📦 Flattening grouped payout: ${record.group.length} individual orders`);
          for (const order of record.group) {
            payouts.push({
              ...order,
              _status: isPaidEndpoint ? 'paid' : order.status || order.payout_status,
              _parent_payout_date: record.payout_date,  // Keep reference to parent payout date
            });
          }
        } else {
          // Regular non-grouped record
          payouts.push({
            ...record,
            _status: isPaidEndpoint ? 'paid' : record.status || record.payout_status,
          });
        }
      }
    }
  }

  return payouts;
}

/**
 * Extracts payout data by parsing the DOM table
 */
async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const payouts = [];

    // Try various table selectors
    const table = document.querySelector('table, .data-table, .payouts-table, [role="table"], [class*="table"]');

    if (!table) {
      // Try looking for list/grid layouts (common in modern UIs)
      const rows = document.querySelectorAll('[class*="payout"], [class*="commission"], [class*="row"]');
      if (rows.length > 0) {
        rows.forEach(row => {
          const textContent = row.textContent.trim();
          if (textContent.includes('$') || textContent.includes('USD')) {
            // This looks like a payout row
            payouts.push({ raw_text: textContent });
          }
        });
      }
      return payouts;
    }

    // Parse table structure
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

      payouts.push(record);
    });

    return payouts;
  });
}

/**
 * Debug function to explore the SocialSnowball page structure
 */
export async function debugPageStructure({ email, password }) {
  const browser = await launchBrowser({ headless: false });
  const page = await createStealthPage(browser);

  // Log all network requests
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
    console.log('   Log in manually and navigate to the Payouts page.');
    console.log('   Watch the console for API calls.');
    console.log('   Press Ctrl+C to close.');
    await new Promise(() => {});
  } catch (error) {
    console.error('Debug session error:', error);
  }
}

