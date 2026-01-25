# BixGrow Commission Scraper

Scrapes commission/transaction data from BixGrow affiliate dashboard and uploads to Google Sheets.

## Features

- Automated login and data extraction from BixGrow
- Network request interception for clean API data capture
- Fallback DOM parsing if API interception fails
- Data transformation to standardized schema
- Automatic deduplication based on transaction_id
- Google Sheets upload via service account

## Prerequisites

- Node.js 18+
- Google Cloud project with Sheets API enabled
- Service account with JSON key file
- BixGrow affiliate account credentials

## Setup

### 1. Install Dependencies

```bash
cd bixgrow-scraper
npm install
```

### 2. Configure Google Cloud

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

### 3. Set Up Google Sheet

**Option A: Use existing sheet**
1. Open your Google Sheet
2. Copy the spreadsheet ID from the URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
3. Share the sheet with your service account email (found in `credentials.json` as `client_email`)

**Option B: Create new sheet**
```bash
node src/index.js --create-sheet
```

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
BIXGROW_EMAIL=your-email@example.com
BIXGROW_PASSWORD=your-password
GOOGLE_SHEET_ID=your-spreadsheet-id
GOOGLE_CREDENTIALS_PATH=./credentials.json
```

## Usage

### Full Scrape + Upload

```bash
npm start
```

### Scrape Only (outputs JSON file)

```bash
npm run scrape
# or
node src/index.js --scrape-only
```

### Debug Mode (visible browser)

```bash
node src/index.js --debug
```

### With Visible Browser

```bash
node src/index.js --visible
```

### Clear Existing Data Before Upload

```bash
node src/index.js --clear
```

### Disable Deduplication

```bash
node src/index.js --no-dedupe
```

## Output Schema

| Column | Required | Format | Description |
|--------|----------|--------|-------------|
| transaction_id | Yes | | Unique identifier |
| advertiser_id | Yes | | Advertiser identifier |
| advertiser_name | Yes | | Advertiser name |
| order_date | Yes | Y-m-d H:i:s | UTC timestamp |
| currency_id | Yes | ISO 4217 | 3-letter code (USD, EUR, etc.) |
| sale_amount | Yes | Cents | Sale amount in cents |
| commission_amount | Yes | Cents | Commission in cents |
| status | Yes | | 'pending', 'approved', or 'declined' |
| click_date | No | Y-m-d H:i:s | Click timestamp (UTC) |
| validation_date | No | Y-m-d H:i:s | Validation timestamp (UTC) |
| modified_date | No | Y-m-d H:i:s | Last modified (UTC) |
| sub_id_1..6 | No | | Sub tracking IDs |
| decline_reason | No | | Decline reason |
| paid_to_publisher | No | '1' or '0' | Payment status |
| clickout_url | No | URL | Destination URL |
| product_title | No | | Product name |
| order_ref | No | | Order reference |

## Troubleshooting

### "Spreadsheet not found"
- Verify the GOOGLE_SHEET_ID in your .env file
- Make sure the ID is from the URL, not the sheet name

### "Permission denied"
- Share your Google Sheet with the service account email
- Find the email in `credentials.json` under `client_email`

### "Could not find login form fields"
- BixGrow may have updated their UI
- Run in debug mode to inspect: `node src/index.js --debug`
- Update selectors in `src/scraper.js` if needed

### No data scraped
- Check if you're logged in correctly
- Run with `--visible` to watch the browser
- Check `error-screenshot-*.png` files for clues

## Development

### Project Structure

```
bixgrow-scraper/
├── src/
│   ├── index.js        # Main entry point
│   ├── scraper.js      # Puppeteer scraping logic
│   ├── transformer.js  # Data transformation
│   └── sheets.js       # Google Sheets API
├── reference/          # UI reference files
├── .env.example        # Environment template
├── credentials.json    # Google service account (gitignored)
└── package.json
```

### Customizing Field Mappings

If BixGrow uses different field names, update the `FIELD_MAPPINGS` object in `src/transformer.js`.

## License

ISC

