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
- pnpm (or npm)
- Google Cloud project with Sheets API enabled
- Service account with JSON key file
- BixGrow affiliate account credentials

## Setup

### 1. Install Dependencies

```bash
cd bixgrow-scraper
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# BixGrow Credentials
BIXGROW_EMAIL=your-email@example.com
BIXGROW_PASSWORD=your-password

# Advertiser Info (customize for your affiliate program)
ADVERTISER_ID=joola
ADVERTISER_NAME=Joola

# Google Sheets
GOOGLE_SHEET_ID=your-spreadsheet-id
GOOGLE_CREDENTIALS_PATH=./credentials.json
SHEET_NAME=Commissions
```

### 3. Configure Google Cloud

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **Google Sheets API**:
   - Navigate to "APIs & Services" → "Library"
   - Search for "Google Sheets API" and enable it
4. Create a service account:
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "Service Account"
   - Give it a name and create
5. Download the JSON key:
   - Click on your service account
   - Go to "Keys" tab → "Add Key" → "Create new key"
   - Select JSON and download
6. Save as `credentials.json` in the project root

### 4. Set Up Google Sheet

1. Create a new Google Sheet (or use existing)
2. Copy the spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
3. Share the sheet with your service account email (found in `credentials.json` as `client_email`)
4. Give the service account **Editor** access

## Usage

### Full Scrape + Upload

```bash
pnpm start
```

### Scrape Only (outputs JSON file)

```bash
pnpm run scrape
```

### With Visible Browser (for debugging)

```bash
pnpm run scrape -- --visible
# or
pnpm start -- --visible
```

### Clear Existing Data Before Upload

```bash
pnpm start -- --clear
```

### Debug Mode (keeps browser open)

```bash
node src/index.js --debug
```

### Disable Deduplication

```bash
pnpm start -- --no-dedupe
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
4. **API Fetch**: Makes paginated API calls to `/api/partner/conversions` with:
   - Auth token for authentication
   - Date range for all-time data (2020 to now)
   - 100 records per page
5. **Transform**: Maps BixGrow fields to standardized schema
6. **Upload**: Sends to Google Sheets with deduplication

## Troubleshooting

### "Spreadsheet not found"
- Verify the `GOOGLE_SHEET_ID` in your `.env` file
- The ID is from the URL: `https://docs.google.com/spreadsheets/d/{THIS_PART}/edit`

### "Permission denied"
- Share your Google Sheet with the service account email
- Find the email in `credentials.json` under `client_email`
- Make sure to give **Editor** access

### "Unauthenticated" API errors
- The auth token may have expired
- Re-run the scraper to get a fresh token

### "socket hang up" errors
- The scraper uses system Chrome instead of Puppeteer's bundled Chromium
- Make sure Google Chrome is installed at `/Applications/Google Chrome.app`

### No data scraped
- Run with `--visible` to watch the browser
- Check `error-screenshot-*.png` or `debug-commissions-page.png` for clues
- Verify your BixGrow credentials are correct

## Project Structure

```
bixgrow-scraper/
├── src/
│   ├── index.js        # Main entry point & CLI
│   ├── scraper.js      # Puppeteer login + API fetching
│   ├── transformer.js  # Data transformation & field mapping
│   └── sheets.js       # Google Sheets API upload
├── reference/          # UI reference files
├── .env                # Environment config (gitignored)
├── credentials.json    # Google service account (gitignored)
└── package.json
```

## Customization

### Changing Advertiser

Update in `.env`:
```env
ADVERTISER_ID=your-advertiser-slug
ADVERTISER_NAME=Your Advertiser Name
```

### Field Mappings

If BixGrow uses different field names, update `FIELD_MAPPINGS` in `src/transformer.js`.

### Status Mappings

BixGrow uses numeric status codes:
- `1` = pending
- `6` = approved
- `2`, `3` = declined

Update `NUMERIC_STATUS_MAP` in `src/transformer.js` if needed.

## License

ISC
