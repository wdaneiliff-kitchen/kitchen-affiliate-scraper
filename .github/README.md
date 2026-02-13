# GitHub Actions

## Scrape and upload (scheduled)

Workflow: [`workflows/scrape-and-upload.yml`](workflows/scrape-and-upload.yml)

- **Schedule:** Daily at 08:00 UTC (edit the `cron` in the workflow to change it).
- **Manual run:** Actions → "Scrape and upload commissions" → "Run workflow".

### Required secrets

In **Settings → Secrets and variables → Actions**, add:

| Secret | Used by |
|--------|--------|
| `BIXGROW_EMAIL` | BixGrow (Joola) |
| `BIXGROW_PASSWORD` | BixGrow (Joola) |
| `SOCIALSNOWBALL_EMAIL` | SocialSnowball (shared across Enhance, CRBN, Friday) |
| `SOCIALSNOWBALL_PASSWORD` | SocialSnowball (shared across Enhance, CRBN, Friday) |
| `SHORTLY_EMAIL` | Shortly (Paddletek) |
| `SHORTLY_PASSWORD` | Shortly (Paddletek) |
| `UPPROMOTE_EMAIL` | UpPromote (shared across all accounts) |
| `UPPROMOTE_PASSWORD` | UpPromote (shared across all accounts) |
| `AFFILIATLY_EMAIL` | Affiliatly |
| `AFFILIATLY_PASSWORD` | Affiliatly |
| `GOOGLE_SHEET_ID` | All (target spreadsheet ID) |
| `GOOGLE_CREDENTIALS_JSON` | All (full contents of your Google service account JSON key file) |

### Optional secrets

| Secret | Used by |
|--------|--------|
| `TWOCAPTCHA_API_KEY` | UpPromote / Affiliatly (recommended for unattended runs) |
| `SLACK_WEBHOOK_URL` | Slack notifications on job success/failure |

### Notes

- For `GOOGLE_CREDENTIALS_JSON`, paste the entire contents of the JSON key file (the one you normally save as `credentials.json`). Multi-line is fine.
- SocialSnowball uses a single set of credentials for all three accounts (Enhance, CRBN, Friday).
- UpPromote uses a single email/password pair; each account also needs its own `*_BASE_URL` secret pointing to the shop's UpPromote URL.
