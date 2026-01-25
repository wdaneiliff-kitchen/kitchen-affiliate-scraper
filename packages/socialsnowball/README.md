# SocialSnowball Payout Scraper

Scrapes payout data from SocialSnowball affiliate dashboard and uploads to Google Sheets.

## Features

- Automated login via Puppeteer
- Network interception to capture API responses
- Data transformation to standardized schema
- Automatic deduplication based on `transaction_id`
- Google Sheets upload via service account
- Headless and visible browser modes

## Prerequisites

- Node.js 18+
- pnpm
- Google Cloud project with Sheets API enabled
- Service account with JSON key file
- SocialSnowball affiliate account credentials

## Setup

### 1. Install Dependencies

From the monorepo root:

```bash
pnpm install
```

### 2. Configure Environment

Create a `.env` file in the monorepo root with:

```env
# SocialSnowball Credentials
SOCIALSNOWBALL_EMAIL=your-email@example.com
SOCIALSNOWBALL_PASSWORD=your-password

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
pnpm socialsnowball

# Scrape only (outputs JSON file)
pnpm socialsnowball:scrape
```

### From Package Directory

```bash
cd packages/socialsnowball

# Full scrape + upload
node src/index.js

# Scrape only
node src/index.js --scrape-only

# With visible browser (for debugging)
node src/index.js --scrape-only --visible

# Debug mode (keeps browser open for API discovery)
node src/index.js --debug

# Create a new Google Sheet
node src/index.js --create-sheet
```

## API Discovery

On first run, the scraper will:
1. Log in and navigate to the Payouts page
2. Capture all API responses
3. Save raw data to a JSON file for inspection

Check the output JSON to see the actual field names, then update `src/config.js` with the correct field mappings.

## Output Schema

Same standardized schema as other scrapers:

| Column | Required | Description |
|--------|----------|-------------|
| transaction_id | Yes | Unique payout/commission ID |
| advertiser_id | Yes | Platform identifier |
| advertiser_name | Yes | Platform display name |
| order_date | Yes | Order/commission timestamp |
| currency_id | Yes | 3-letter ISO code |
| sale_amount | Yes | Sale amount in cents |
| commission_amount | Yes | Commission in cents |
| status | Yes | 'pending', 'approved', or 'declined' |

## Customization

### Field Mappings

Update `FIELD_MAPPINGS` in `src/config.js` after discovering the actual API response structure.

### Status Mappings

Update `STATUS_MAPPINGS` in `src/config.js` based on how SocialSnowball represents payout statuses.

