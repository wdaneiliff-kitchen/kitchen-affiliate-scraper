---
name: report
description: Health check for the kitchen-affiliate-scraper. Cross-checks recent workflow runs, drift and accuracy audits, audit-aggregate freshness, cookie expiry, and sheet state. Outputs a single green/yellow/red summary. Use when Dane asks whether everything is running smoothly, whether the scraper is ok, for a status check, or whether the latest scrape went through.
---

# Report — scraper health check

A one-shot diagnostic. Read these checks in parallel, then synthesize a short report.

## Tone & length

- Output ≤ 25 lines unless something is broken.
- Lead with a single status header: `✅ Running clean` / `⚠️ Minor issues` / `🚨 Needs attention`.
- For each check, one line of result. Don't narrate "I'm now checking X" — just show findings.
- Don't propose fixes unless asked. The user wants a snapshot, not a TODO list.

## Severity rules

- **🚨 Red:** any workflow run with `failure` status in the last 24h; SAFETY GUARD triggered on a brand we don't expect (anything other than the long-quiet UpPromote brands); a drift-audit drop >5 rows AND >5% on any brand; accuracy audit Slack-worthy discrepancy; cookies already expired; any brand's audit aggregate `captured_at` is >6 hours old; scrape hasn't run in >3 hours despite scheduled crons; `Unknown status "X"` warning in scrape logs (UpPromote added a status code we haven't mapped).
- **⚠️ Yellow:** cron delay >1 hour on overnight slot (known GH Actions issue); cookies expiring within 7 days; non-fatal scrape warnings; one brand's aggregate stale (1–6h); 2Captcha balance low.
- **✅ Green:** everything else.

## Checks to run (in parallel where possible)

Run these as a batch via parallel Bash tool calls — they're independent.

### 1. Recent workflow runs

```
gh run list --limit 30 --repo wdaneiliff-kitchen/kitchen-affiliate-scraper
```

Look for: any `failure` status in the last 24h. Compare actual run start times to the cron schedule in `.github/workflows/scrape-and-upload.yml` (`:13`/`:43`/`:28` past relevant UTC hours). Note any delays >1 hour.

### 2. Most recent scrape's reconcile output

```
gh run view <latest-scrape-run-id> --repo wdaneiliff-kitchen/kitchen-affiliate-scraper --log 2>&1 | grep -E "Inserted|Updated|Deleted|SAFETY|❌|💥|Audit aggregate" | head -80
```

Look for: SAFETY GUARD warnings (legit for the long-quiet brands `pickleballapes/udrippin/gruvn/neonic/chorus/thrive/mark/gherkin` — see CLAUDE.md — concerning for any other brand). Any per-scraper `❌` errors. Any `Unknown status` warnings (UpPromote status code we haven't mapped — add to `packages/uppromote/src/config.js` STATUS_MAPPINGS).

### 3. Drift audit (last 2 days vs today)

Run from `packages/shared`:
```js
const { google } = require('googleapis');
const fs = require('fs');
const credentials = JSON.parse(fs.readFileSync('../../credentials.json'));
const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID, range: 'Drift Audit!A:E' });
// Get latest 3 snapshot dates per advertiser, compute day-over-day deltas
```

Source `.env` first to get `GOOGLE_SHEET_ID`. Look for: any brand with `(today.count - yesterday.count) < -5` AND `(today.count - yesterday.count) / yesterday.count < -0.05`.

### 4. Accuracy audit latest run

```
gh run view <latest-accuracy-audit-run-id> --repo wdaneiliff-kitchen/kitchen-affiliate-scraper --log 2>&1 | tail -40
```

Look for: any `🚨` lines, any "Slack alert sent" message (means discrepancy), any `Unknown status` warnings.

### 5. Audit Aggregates freshness

Same Sheets pattern as #3, range `Audit Aggregates!A:G`. For each row, parse `captured_at` (column G, Central time `YYYY-MM-DD HH:MM:SS`). Compare to current Central time. Flag if any brand's captured_at is > 2 hours stale (yellow) or > 6 hours stale (red).

Note: `captured_at` is Central time, not UTC. Convert current UTC → Central before comparing.

### 6. Cookie expiry

```bash
for f in packages/*/.cookies/*-cookies.json packages/*/.cookies/*-cookies.json; do
  node -e "
    const c = JSON.parse(require('fs').readFileSync('$f', 'utf-8'));
    const now = Date.now()/1000;
    const expiring = c.filter(x => x.expires && x.expires > 0 && x.expires < now + 7*86400);
    if (expiring.length) {
      const earliest = Math.min(...expiring.map(x => x.expires));
      const days = ((earliest - now) / 86400).toFixed(1);
      console.log('$f', '— ' + (earliest < now ? 'EXPIRED' : days + ' days left'));
    }
  " 2>/dev/null
done
```

Flag brands with any cookie within 7 days of expiry (yellow) or already expired (red).

### 7. Sheet state snapshot

```js
const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Comissions!A:H' });
const rows = r.data.values || [];
const totalRows = rows.length - 1;
const today = '2026-...'  // current Central date YYYY-MM-DD
const todayRows = rows.filter(r => (r[3]||'').startsWith(today)).length;
const latestPerBrand = {};
for (let i = 1; i < rows.length; i++) {
  const adv = rows[i][1], date = rows[i][3];
  if (!latestPerBrand[adv] || date > latestPerBrand[adv]) latestPerBrand[adv] = date;
}
```

Useful for one-line context: total rows, today's row count, oldest "latest per brand" timestamp (if any brand's latest sale is > 24h old, that's worth flagging).

## Output template

```
{✅|⚠️|🚨} {status header}

Workflows:    {N} runs in last 24h, {N} failures, last scrape {Xm ago}
Reconcile:    {summary of inserts/updates/deletes, or "clean (0/0/0)" if quiet}
Drift audit:  {N} brands within threshold, {issues if any}
Accuracy:     last run at {time}, {N} brands within tolerance
Aggregates:   all fresh / N brand(s) stale: {list}
Cookies:      {all good / N expiring soon: list}
Sheet:        {total} rows, {todayCount} today, latest sale {timestamp}

{Issues section, only if any. Bulleted, one line each, with the specific brand/file/run-id.}
```

## When NOT to fix

This skill is read-only. Don't push commits or kick off scrapes from inside it. If a 🚨 issue surfaces, mention it in the output — let Dane decide whether to address.
