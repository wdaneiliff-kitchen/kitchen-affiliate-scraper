import {
  sleep,
  findSelector,
  launchBrowser,
  createStealthPage,
  setupNetworkInterception,
  getCookieString,
  getAuthToken,
} from '@kitchen/shared/scraper-base';

const LOGIN_URL = 'https://shortly.link/influencer/login';
const DASHBOARD_URL = 'https://shortly.link/influencer/dashboard';

/**
 * Scrapes payout data from Shortly affiliate dashboard.
 * Uses network interception to capture API responses for cleaner data extraction.
 *
 * @param {Object} options - Scraper options
 * @param {string} options.email - Shortly login email
 * @param {string} options.password - Shortly login password
 * @param {string} [options.shopName] - Shop name to select (if multiple shops)
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @returns {Promise<Array>} Array of payout/commission objects
 */
export async function scrapePayouts({ email, password, shopName, headless = true }) {
  console.log('🚀 Starting Shortly scraper...');
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
      if (data.payload && Array.isArray(data.payload)) {
        records = data.payload;
      } else if (data.data?.data && Array.isArray(data.data.data)) {
        records = data.data.data;
      } else if (Array.isArray(data.data)) {
        records = data.data;
      } else if (data.payouts && Array.isArray(data.payouts)) {
        records = data.payouts;
      } else if (data.commissions && Array.isArray(data.commissions)) {
        records = data.commissions;
      } else if (data.conversions && Array.isArray(data.conversions)) {
        records = data.conversions;
      } else if (Array.isArray(data)) {
        records = data;
      }

      // Capture responses that look like payout data
      const urlLower = url.toLowerCase();
      const isPayoutEndpoint =
        urlLower.includes('payout') ||
        urlLower.includes('commission') ||
        urlLower.includes('conversion') ||
        urlLower.includes('earning') ||
        urlLower.includes('transaction');

      // Exclude notification/user endpoints
      const isExcluded =
        urlLower.includes('notification') ||
        urlLower.includes('/user') ||
        urlLower.includes('/auth');

      if (records && records.length > 0 && isPayoutEndpoint && !isExcluded) {
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
    await page.waitForSelector('input[type="email"], input[placeholder*="email" i], input[name="email"], input[type="text"]', {
      timeout: 15000
    });

    // Step 2: Fill in login credentials
    console.log('🔐 Entering credentials...');

    // Shortly uses custom focus/defocus handlers and async email validation
    // We need to properly trigger these handlers
    await page.evaluate((emailValue) => {
      const emailInput = document.getElementById('email');
      if (!emailInput) throw new Error('Could not find email input');

      // Focus, set value, then call their defocused() function
      emailInput.focus();
      if (typeof focused === 'function') focused(emailInput);
      emailInput.value = emailValue;
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
    }, email);

    // Wait for async email validation (Shortly checks if email exists in DB)
    console.log('   ⏳ Waiting for email validation...');
    await sleep(3000);

    // Now fill password
    await page.evaluate((passwordValue) => {
      const emailInput = document.getElementById('email');
      const passwordInput = document.getElementById('password');
      if (!passwordInput) throw new Error('Could not find password input');

      // Trigger defocused on email first
      if (typeof defocused === 'function') defocused(emailInput);

      // Focus and fill password
      passwordInput.focus();
      if (typeof focused === 'function') focused(passwordInput);
      passwordInput.value = passwordValue;
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof defocused === 'function') defocused(passwordInput);
    }, password);

    await sleep(500);

    // Step 3: Submit login form
    console.log('🔑 Submitting login...');

    // Click the #login button (type="button", not submit)
    await page.click('#login');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    // Wait for login to complete
    await sleep(3000);

    // Check if login was successful
    let currentUrl = page.url();
    console.log(`   Current URL after login: ${currentUrl}`);

    if (currentUrl.includes('login')) {
      throw new Error('Login failed - still on login page. Check credentials.');
    }

    // Step 4: Handle shop selection if on "Shops" page
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('   Checking for shop selection page...');

    if (pageText.includes('SHOP INVITATIONS') || pageText.includes('VIEW DETAILS HERE')) {
      console.log('🏪 Shop selection page detected!');
      await sleep(1000);

      // Click "View Details Here" button - it's a dark button with that text
      const shopSelected = await page.evaluate((targetShop) => {
        // Find all buttons
        const allButtons = Array.from(document.querySelectorAll('button'));

        for (const btn of allButtons) {
          const btnText = btn.textContent.trim().toLowerCase();
          if (btnText.includes('view details here')) {
            // Check if this is for the right shop
            const parent = btn.closest('.card') || btn.parentElement?.parentElement?.parentElement;
            const parentText = parent?.textContent || '';

            if (!targetShop || parentText.toLowerCase().includes(targetShop.toLowerCase())) {
              btn.click();
              return { clicked: true, shop: parentText.split('\n').find(s => s.trim()) || 'unknown' };
            }
          }
        }

        // Fallback: click first "View Details Here" button
        const detailsBtn = allButtons.find(btn => btn.textContent.toLowerCase().includes('view details here'));
        if (detailsBtn) {
          detailsBtn.click();
          return { clicked: true, shop: 'first available' };
        }

        return { clicked: false, buttons: allButtons.map(b => b.textContent.trim().slice(0, 50)) };
      }, shopName);

      if (shopSelected.clicked) {
        console.log(`   ✅ Selected shop: ${shopSelected.shop}`);
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await sleep(2000);
        currentUrl = page.url();
        console.log(`   Current URL after shop selection: ${currentUrl}`);
      } else {
        console.log('   ⚠️ Could not find shop selection button');
        console.log('   Available buttons:', shopSelected.buttons);
      }
    } else {
      console.log('   ✓ Already on dashboard (no shop selection needed)');
    }

    // Step 5: Navigate to Orders section (where commission details are)
    console.log('📊 Looking for Orders/Commission section...');

    // Wait for the shop dashboard to fully load
    await sleep(2000);

    // Try clicking the Orders link in the sidebar
    const ordersLinkClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const targetLink = links.find(a => {
        const text = a.textContent.trim().toLowerCase();
        const href = (a.href || '').toLowerCase();
        return text.includes('order') ||
               text.includes('commission') ||
               text.includes('payout') ||
               text.includes('earning') ||
               href.includes('order') ||
               href.includes('commission');
      });
      if (targetLink) {
        targetLink.click();
        return { clicked: true, text: targetLink.textContent.trim(), href: targetLink.href };
      }
      // Return available links for debugging
      const availableLinks = links.map(a => ({ text: a.textContent.trim().slice(0, 30), href: a.href }));
      return { clicked: false, links: availableLinks.filter(l => l.text.length > 0).slice(0, 15) };
    });

    if (ordersLinkClicked.clicked) {
      console.log(`   ✅ Clicked "${ordersLinkClicked.text}" link (${ordersLinkClicked.href})`);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(2000);
    } else {
      console.log('   ⚠️ Could not find Orders link, staying on current page');
      console.log('   Available links:', JSON.stringify(ordersLinkClicked.links, null, 2));
    }

    // Wait for the page to load data
    console.log('⏳ Waiting for page data to load...');
    await sleep(5000);

    console.log(`   Current URL: ${page.url()}`);

    // Take a screenshot to debug the page structure
    await page.screenshot({ path: 'shortly-dashboard.png', fullPage: true });
    console.log('   📸 Saved debug screenshot: shortly-dashboard.png');

    // Try scrolling to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

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

    // Fall back to DOM parsing if no API data
    if (payouts.length === 0) {
      console.log('📄 Trying DOM parsing...');
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
 */
async function fetchAllPayouts(page, authToken, capturedResponses) {
  const allRecords = [];

  if (capturedResponses.length > 0) {
    const { url, records } = capturedResponses[0];
    allRecords.push(...records);

    const baseUrl = url.split('?')[0];
    console.log(`   📡 Detected API endpoint: ${baseUrl}`);

    const cookieString = await getCookieString(page);
    let currentPage = 2;
    let hasMore = true;

    while (hasMore && currentPage <= 50) {
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

        let pageRecords = null;
        if (data.data?.data && Array.isArray(data.data.data)) {
          pageRecords = data.data.data;
        } else if (Array.isArray(data.data)) {
          pageRecords = data.data;
        } else if (data.payouts && Array.isArray(data.payouts)) {
          pageRecords = data.payouts;
        } else if (data.commissions && Array.isArray(data.commissions)) {
          pageRecords = data.commissions;
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
 */
function extractFromApiResponses(apiResponses) {
  const payouts = [];

  for (const { records } of apiResponses) {
    if (records && Array.isArray(records)) {
      payouts.push(...records);
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

    const table = document.querySelector('table, .data-table, .payouts-table, [role="table"], [class*="table"]');

    if (!table) {
      const rows = document.querySelectorAll('[class*="payout"], [class*="commission"], [class*="row"], [class*="earning"]');
      if (rows.length > 0) {
        rows.forEach(row => {
          const textContent = row.textContent.trim();
          if (textContent.includes('$') || textContent.includes('USD')) {
            payouts.push({ raw_text: textContent });
          }
        });
      }
      return payouts;
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

      payouts.push(record);
    });

    return payouts;
  });
}

/**
 * Debug function to explore the Shortly page structure
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
    console.log('   Log in manually and navigate to the Payouts page.');
    console.log('   Watch the console for API calls.');
    console.log('   Press Ctrl+C to close.');
    await new Promise(() => {});
  } catch (error) {
    console.error('Debug session error:', error);
  }
}

