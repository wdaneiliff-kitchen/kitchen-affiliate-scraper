# Shortly Affiliate Scraper

Scrapes payout data from Shortly (shortly.link) affiliate dashboard and uploads to Google Sheets.

## Setup

1. Add your Shortly credentials to the `.env` file in the monorepo root:

```bash
SHORTLY_EMAIL=alex@thekitchenpickle.com
SHORTLY_PASSWORD=your-password
```

2. Install dependencies:

```bash
cd packages/shortly
pnpm install
```

## Usage

### Scrape Only (save to JSON)

```bash
pnpm run scrape
# or
node src/index.js --scrape-only
```

### Scrape and Upload to Google Sheets

```bash
pnpm start
# or
node src/index.js
```

### Debug Mode (opens browser for manual inspection)

```bash
node src/index.js --debug
```

### Visible Browser Mode

Run with visible browser window instead of headless:

```bash
node src/index.js --visible --scrape-only
```

## Command Line Options

| Option | Description |
|--------|-------------|
| `--scrape-only` | Only scrape data, save to JSON file (skip upload) |
| `--upload-only` | Upload existing JSON data (not fully implemented) |
| `--debug` | Open browser for manual inspection |
| `--visible` | Run with visible browser window |
| `--create-sheet` | Create a new Google Sheet for storing data |
| `--clear` | Clear existing data before uploading |
| `--no-dedupe` | Don't skip duplicate records |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHORTLY_EMAIL` | Yes | Shortly login email |
| `SHORTLY_PASSWORD` | Yes | Shortly login password |
| `GOOGLE_SHEET_ID` | For upload | Target Google Sheet ID |
| `GOOGLE_CREDENTIALS_PATH` | For upload | Path to Google service account credentials |
| `SHEET_NAME` | No | Sheet name (default: "Commissions") |
| `DEBUG` | No | Enable verbose debug output |

## Output

### JSON Output

Scraped data is saved to `shortly-default-payouts-YYYY-MM-DD.json` containing:
- `raw`: Original records from Shortly
- `transformed`: Records transformed to the target schema

### Screenshots

- `shortly-dashboard.png` - Debug screenshot of the dashboard page
- `error-screenshot-*.png` - Screenshots captured on errors

