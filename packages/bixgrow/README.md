# BixGrow Commission Scraper

Scrapes commission/transaction data from BixGrow affiliate dashboard (e.g., Joola) and uploads to Google Sheets.

## Features

- Automated login and JWT token capture
- Direct API calls with pagination (fetches all historical data)
- Auth token extraction for authenticated API requests
- Data transformation to standardized schema
- Automatic deduplication based on `transaction_id`
- Google Sheets upload via service account
- Extracts product titles from nested line items
- Headless and visible browser modes

## Prerequisites

- Node.js 18+
- pnpm
- Google Cloud project with Sheets API enabled
- Service account with JSON key file
- BixGrow affiliate account credentials

## Setup

### 1. Install Dependencies

From the monorepo root:

```bash
pnpm install
```

### 2. Configure Environment

Create a `.env` file in the monorepo root with:

```env
# BixGrow Credentials
BIXGROW_EMAIL=your-email@example.com
BIXGROW_PASSWORD=your-password

# Advertiser Info (customize for your affiliate program)
ADVERTISER_ID=joola
ADVERTISER_NAME=Joola

# Google Sheets
GOOGLE_SHEET_ID=your-spreadsheet-id
```

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
# Full scrape + transform + upload
pnpm bixgrow

# Scrape only (outputs JSON file)
pnpm bixgrow:scrape
```

### From Package Directory

```bash
cd packages/bixgrow

# Full scrape + upload
node src/index.js

# Scrape only
node src/index.js --scrape-only

# With visible browser (for debugging)
node src/index.js --scrape-only --visible

# Debug mode (keeps browser open)
node src/index.js --debug

# Create a new Google Sheet
node src/index.js --create-sheet
```

## Output Schema

| Column | Required | Format | Description |
|--------|----------|--------|-------------|
| transaction_id | Yes | Integer | Unique BixGrow conversion ID |
| advertiser_id | Yes | String | Advertiser slug (e.g., "joola") |
| advertiser_name | Yes | String | Advertiser display name |
| order_date | Yes | Y-m-d H:i:s | Order creation timestamp |
| currency_id | Yes | ISO 4217 | 3-letter code (USD, EUR, etc.) |
| sale_amount | Yes | Cents | Sale amount in cents |
| commission_amount | Yes | Cents | Commission in cents |
| status | Yes | String | 'pending', 'approved', or 'declined' |
| click_date | No | Y-m-d H:i:s | Click timestamp |
| validation_date | No | Y-m-d H:i:s | Approval timestamp |
| modified_date | No | Y-m-d H:i:s | Last modified timestamp |
| sub_id_1 | No | Integer | Click ID |
| sub_id_2..6 | No | String | Additional tracking IDs (tid1-tid3) |
| decline_reason | No | String | Decline/rejection reason |
| paid_to_publisher | No | '1' or '0' | Payment status |
| clickout_url | No | URL | Destination/tracking URL |
| product_title | No | String | Product name(s) from order |
| order_ref | No | String | Order reference (e.g., "#135058") |

## How It Works

1. **Login**: Navigates to BixGrow login page and authenticates
2. **Token Capture**: Intercepts the JWT auth token from login response
3. **Navigation**: Clicks to the Commissions page
4. **API Fetch**: Makes paginated API calls to `/api/partner/conversions`
5. **Transform**: Maps BixGrow fields to standardized schema
6. **Upload**: Sends to Google Sheets with deduplication

## Customization

### Field Mappings

If BixGrow uses different field names, update `FIELD_MAPPINGS` in `src/config.js`.

### Status Mappings

BixGrow uses numeric status codes:
- `1` = pending
- `6` = approved
- `2`, `3` = declined

Update `STATUS_MAPPINGS` in `src/config.js` if needed.

