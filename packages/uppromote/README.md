# UpPromote Commission Scraper

Scrapes commission/transaction data from UpPromote affiliate dashboard and uploads to Google Sheets.

## Supported Brands

- **Luzz** (default)
- **Honolulu**
- **Holbrook**
- **Diadem**
- **Pickleball Apes**
- **UDrippin**
- **11six24**
- **Vatic**
- **Gruvn**
- **Six Zero**

### Quick start: LUZZ

To try the scraper with LUZZ, set these in `.env` at the monorepo root:

```env
UPPROMOTE_EMAIL=your-affiliate-email@example.com
UPPROMOTE_PASSWORD=your-password
TWOCAPTCHA_API_KEY=your-2captcha-key   # Optional: auto-solve reCAPTCHA on login
GOOGLE_SHEET_ID=your-spreadsheet-id
```

Then run (default account is LUZZ):

```bash
pnpm uppromote -- --account=luzz
# or scrape only:
pnpm uppromote:scrape -- --account=luzz
```

## Features

- Multi-account support (scrape one or all brands)
- Automated login to UpPromote affiliate portal
- Network interception to capture API responses
- DOM parsing fallback for data extraction
- Pagination support for large datasets
- Data transformation to standardized schema
- Automatic deduplication based on `transaction_id`
- Google Sheets upload via service account
- Headless and visible browser modes

## Prerequisites

- Node.js 18+
- pnpm
- Google Cloud project with Sheets API enabled
- Service account with JSON key file
- UpPromote affiliate account credentials for each brand

## Setup

### 1. Install Dependencies

From the monorepo root:

```bash
pnpm install
```

### 2. Configure Environment

Create a `.env` file in the monorepo root with credentials for each brand:

```env
# Shared fallback credentials (used when per-account vars aren't set)
UPPROMOTE_EMAIL=your-email@example.com
UPPROMOTE_PASSWORD=your-password

# Per-account credential overrides (only needed when they differ from shared)
# UPPROMOTE_LUZZ_EMAIL=different-email@example.com
# UPPROMOTE_UDRIPPIN_EMAIL=different-email@example.com
# UPPROMOTE_UDRIPPIN_PASSWORD=different-password
# UPPROMOTE_GRUVN_EMAIL=different-email@example.com
# UPPROMOTE_GRUVN_PASSWORD=different-password
# UPPROMOTE_SIXZERO_EMAIL=different-email@example.com

# Optional: 2Captcha for auto-solving reCAPTCHA on login
# TWOCAPTCHA_API_KEY=your-2captcha-api-key

# Google Sheets
GOOGLE_SHEET_ID=your-spreadsheet-id
```

**Note:** Base URLs are hardcoded in `src/config.js` so `UPPROMOTE_*_BASE_URL` env vars are only needed if you want to override them. Credentials fall back to the shared `UPPROMOTE_EMAIL`/`UPPROMOTE_PASSWORD` when per-account vars aren't set.

### 3. Configure Google Cloud

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **Google Sheets API**
4. Create a service account and download the JSON key
5. Save as `credentials.json` in the monorepo root
6. Share your Google Sheet with the service account email

## Usage

### From Monorepo Root

```bash
# Scrape + upload specific brand
pnpm uppromote                           # Default (Luzz)
pnpm uppromote -- --account=luzz
pnpm uppromote -- --account=honolulu
pnpm uppromote -- --account=holbrook
pnpm uppromote -- --account=diadem
pnpm uppromote -- --account=pickleballapes
pnpm uppromote -- --account=udrippin
pnpm uppromote -- --account=11six24
pnpm uppromote -- --account=vatic
pnpm uppromote -- --account=gruvn
pnpm uppromote -- --account=sixzero

# Scrape + upload ALL brands
pnpm uppromote:all

# Scrape only (outputs JSON file)
pnpm uppromote:scrape                    # Default (Luzz)
pnpm uppromote:scrape -- --account=luzz
pnpm uppromote:all:scrape                # All brands
```

### From Package Directory

```bash
cd packages/uppromote

# Single account
node src/index.js --account=luzz
node src/index.js --account=honolulu
node src/index.js --account=holbrook
node src/index.js --account=diadem
node src/index.js --account=pickleballapes
node src/index.js --account=udrippin
node src/index.js --account=11six24
node src/index.js --account=vatic
node src/index.js --account=gruvn
node src/index.js --account=sixzero

# All accounts
node src/index.js --account=all

# Scrape only
node src/index.js --account=luzz --scrape-only
node src/index.js --account=all --scrape-only

# With visible browser (for debugging)
node src/index.js --account=luzz --scrape-only --visible

# Debug mode (keeps browser open)
node src/index.js --account=luzz --debug

# Create a new Google Sheet
node src/index.js --create-sheet
```

## UpPromote URL Structure

- **Base URL**: `https://af.uppromote.com/{shop-id}`
- **Commission List**: `https://af.uppromote.com/{shop-id}/commission`
- **Order Detail**: `https://af.uppromote.com/{shop-id}/commission/order-detail/{referral-id}`

## Output Schema

| Column | Required | Format | Description |
|--------|----------|--------|-------------|
| transaction_id | Yes | Integer | Unique UpPromote referral ID |
| advertiser_id | Yes | String | Brand slug (luzz, honolulu, holbrook, diadem, pickleballapes, udrippin, 11six24, vatic, gruvn, sixzero) |
| advertiser_name | Yes | String | Brand display name |
| order_date | Yes | Y-m-d H:i:s | Order creation timestamp |
| currency_id | Yes | ISO 4217 | 3-letter code (USD, EUR, etc.) |
| sale_amount | Yes | Cents | Total sale amount in cents |
| commission_amount | Yes | Cents | Commission in cents |
| status | Yes | String | 'pending', 'approved', or 'declined' |
| click_date | No | Y-m-d H:i:s | Click timestamp |
| validation_date | No | Y-m-d H:i:s | Approval timestamp |
| modified_date | No | Y-m-d H:i:s | Last modified timestamp |
| sub_id_1..6 | No | String | Additional tracking IDs |
| decline_reason | No | String | Decline/rejection reason |
| paid_to_publisher | No | '1' or '0' | Payment status |
| clickout_url | No | URL | Destination/tracking URL |
| product_title | No | String | Product name(s) from order |
| order_ref | No | String | Order reference (e.g., "#25559") |

## How It Works

1. **Login**: Navigates to UpPromote login page and authenticates
2. **Navigation**: Goes to the Commission tab
3. **Data Capture**: Intercepts API responses or parses DOM tables
4. **Pagination**: Iterates through all pages to collect all records
5. **Transform**: Maps UpPromote fields to standardized schema
6. **Upload**: Sends to Google Sheets with deduplication

## UpPromote Data Fields

Based on the UpPromote dashboard, the following fields are available:

| UpPromote Field | Description | Maps To |
|-----------------|-------------|---------|
| referral_id | Unique referral identifier | transaction_id |
| order_number | Shopify order number (e.g., #25559) | order_ref |
| created_at | Conversion date/time | order_date |
| total_sales | Total sale amount | sale_amount |
| quantity | Number of items | - |
| commission | Commission amount | commission_amount |
| status | Pending/Approved/Declined | status |
| customer_address | Customer shipping info | - |
| source | Traffic source | - |

## Customization

### Adding a New Brand

1. Add the base URL to `ACCOUNT_BASE_URLS` in `src/config.js`:

```js
newbrand: 'https://af.uppromote.com/newbrand-shop-id',
```

2. Add the account entry to `getAccount()` in `src/config.js`:

```js
newbrand: {
  email: resolveCredential('newbrand', 'EMAIL'),
  password: resolveCredential('newbrand', 'PASSWORD'),
  baseUrl: resolveBaseUrl('newbrand'),
  advertiserId: 'newbrand',
  advertiserName: 'New Brand',
},
```

3. Add to the `ACCOUNT_NAMES` array in `src/config.js`

4. Add environment variables to `.env` (or set GitHub secrets for CI):
   - `UPPROMOTE_NEWBRAND_EMAIL`
   - `UPPROMOTE_NEWBRAND_PASSWORD`

5. Add cookie path to `.github/workflows/scrape-and-upload.yml` session cache

### Field Mappings

If UpPromote uses different field names, update `FIELD_MAPPINGS` in `src/config.js`.

### Status Mappings

UpPromote uses string status values:
- `pending` = pending
- `approved` = approved
- `declined` = declined

Update `STATUS_MAPPINGS` in `src/config.js` if needed for numeric codes.

## CAPTCHA Handling

UpPromote uses reCAPTCHA on their login page. The scraper provides two ways to handle this:

### Option 1: Cookie Persistence (Recommended - Free)

After solving CAPTCHA once, the scraper saves your session cookies. Future runs will skip login entirely:

```bash
# First run - solve CAPTCHA manually (need --visible)
pnpm uppromote:scrape -- --account=luzz --visible

# Future runs - uses saved cookies, no CAPTCHA needed!
pnpm uppromote:scrape -- --account=luzz
```

Cookies are saved per-account in `packages/uppromote/.cookies/`.

### Option 2: 2captcha Auto-Solve (Paid)

For fully automated runs, use [2captcha.com](https://2captcha.com) (~$3 per 1000 solves):

```env
# Add to .env
TWOCAPTCHA_API_KEY=your-api-key-here
```

The scraper will automatically send CAPTCHAs to 2captcha and wait for solutions.

### Manual Solving (Fallback)

If cookies expire and you don't have 2captcha, run with `--visible`:

```bash
pnpm uppromote:scrape -- --account=luzz --visible
```

The scraper will:
1. Open a visible browser window
2. Wait up to 120 seconds for you to solve the CAPTCHA
3. Continue scraping after you solve it
4. Save cookies for next time

## Troubleshooting

### Login Issues
- Verify credentials in `.env` file
- Delete old cookies: `rm packages/uppromote/.cookies/*.json`
- Run with `--visible` flag to see what's happening

### No Data Found
- Run with `--debug` flag to inspect the page
- Check the debug screenshot saved on error
- Verify you have commission data in your UpPromote account

### Rate Limiting
- Add delays between pagination requests if needed
- Consider running during off-peak hours
