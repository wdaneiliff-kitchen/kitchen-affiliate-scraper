# CLAUDE.md

This file is the **single source of truth** for working on this repo with Claude Code. Read it first at the start of every session and treat it as authoritative context. Update it whenever something meaningful changes (see "Session workflow" at the bottom).

---

## 1. Who is this for

**Dane** maintains this repo at The Kitchen Pickleball. He is **not a developer** — his job is to keep the scrapers running, debug failures, and ship small fixes. He uses Claude Code as his debugging partner and prefers **plain-English explanations without jargon**. When proposing changes, walk through what will happen and why; don't assume he'll read the diff to figure it out.

---

## 2. What this project does

A **pnpm monorepo** of automated scrapers that collect affiliate commission data from many partner platforms and push it to **one shared Google Sheet**. That sheet feeds a **Looker Studio** dashboard so finance/ops can see sales and commissions across all brands in one place — instead of logging into a dozen different affiliate tools by hand.

- Live sheet: https://docs.google.com/spreadsheets/d/1DWtmjS3575qsrOhEkv7IpjNp9YDtKEcleFpofKy9N4E/edit
- Repo on GitHub: https://github.com/wdaneiliff-kitchen/kitchen-affiliate-scraper
- Scheduled runs: 7am–11:45pm Central (13 runs/day) via GitHub Actions — every 1.5 hours through 10pm, then extra runs at 11pm and 11:45pm so the data feeding the 11:59pm RPM EOD job is as fresh as possible
- Manual trigger: `pnpm scraper` (kicks off the GH Actions workflow) or the **Actions** tab on GitHub

---

## 3. Repo layout

```
kitchen-affiliate-scraper-main/
├── .github/
│   ├── README.md                 # GH Actions secrets reference
│   └── workflows/
│       ├── scrape-and-upload.yml # Main scheduled scraper run (every 1.5h)
│       ├── rpm-eod-snapshot.yml  # Nightly 11:59pm Central RPM reconciliation
│       └── migrate-dates.yml     # One-time UTC→Central migration (manual only)
├── docs/
│   ├── LOOKER_STUDIO.md          # Dashboard schema, calculated fields, gotchas
│   └── MANUAL_NETWORKS.md        # Networks that can't be scraped (Refersion notes)
├── packages/
│   ├── shared/                   # Common helpers (transformer, sheets, base scraper)
│   ├── bixgrow/                  # Joola
│   ├── socialsnowball/           # Enhance, CRBN, Friday
│   ├── shortly/                  # Paddletek
│   ├── uppromote/                # 15+ pickleball brands (see below)
│   ├── affiliatly/               # Engage
│   ├── goaffpro/                 # Forwrd
│   ├── rpm/                      # RPM Pickleball (Shopify Collabs)
│   └── refersion/                # Gearbox, ERNE, Volair
├── package.json                  # Root pnpm scripts (pnpm bixgrow, pnpm uppromote:all, etc.)
├── credentials.json              # Google service account (gitignored, local only)
└── .env                          # All credentials (gitignored, local only)
```

---

## 4. Scrapers — quick reference

Each package follows the same pattern: **scrape → transform → upload to Google Sheet**. Run any of them from the repo root:

| Command | Platform | Brands |
|---|---|---|
| `pnpm bixgrow` | BixGrow | Joola |
| `pnpm socialsnowball:all` | SocialSnowball | Enhance, CRBN, Friday |
| `pnpm shortly` | Shortly | Paddletek |
| `pnpm uppromote:all` | UpPromote | Luzz, Honolulu, Holbrook, Diadem, Pickleball Apes, UDrippin, 11six24, Vatic, Gruvn, Six Zero, Neonic, Chorus, Thrive, Mark, Gherkin, Proton, Aireo |
| `pnpm affiliatly` | Affiliatly | Engage |
| `pnpm goaffpro` | GoAffPro | Forwrd |
| `pnpm rpm` | Shopify Collabs | RPM Pickleball |
| `pnpm refersion` | Refersion | Gearbox, ERNE, Volair |

Add `:scrape` (e.g. `pnpm bixgrow:scrape`) to skip the upload step and just dump JSON locally — useful for debugging.

Add `--account=<name>` for multi-account scrapers, or `--account=all`. Add `--visible` to see the browser, `--debug` to keep it open, `--scrape-only` to skip the upload.

---

## 5. Architecture & data flow

```
[Affiliate platform UI/API]
        ↓ (Puppeteer login + scrape, or direct API after token capture)
[Per-package scraper writes raw JSON]
        ↓ (shared transformer maps fields → standard schema)
[Standardized rows in cents, dates as 'YYYY-MM-DD HH:MM:SS' Central]
        ↓ (shared sheets.js uploads with dedupe by transaction_id)
[Google Sheet "Comissions" tab — note the typo, that's the real tab name]
        ↓ (Looker Studio reads via Sheets connector)
[Dashboard]
```

### Standardized schema (columns A–V on the sheet)

22 columns written by `packages/shared/src/transformer.js`. Key fields:

- `transaction_id` — natural ID from platform, or `gen_<hash>` if generated
- `advertiser_id` / `advertiser_name` — brand slug + display name
- `order_date` — `YYYY-MM-DD HH:MM:SS` in **Central time** (America/Chicago)
- `sale_amount` / `commission_amount` — **integer cents** (not dollars)
- `status` — normalized to `pending`, `approved`, or `declined`

Full column reference: see `docs/LOOKER_STUDIO.md`.

### Special tabs in the sheet

- `Comissions` (sic) — main commission rows from all scrapers (reconciled, not append-only — see Conventions)
- `RPM Commissions` — RPM cumulative tracking (Sales + Earned columns from Shopify Collabs analytics page)
- `RPM Daily Snapshots` — end-of-day closing totals; written nightly at 11:59pm Central by `rpm-eod-snapshot.yml`
- `Drift Audit` — per-brand row count + commission totals snapshotted nightly by `drift-audit.yml` for the day-over-day watchdog

### How RPM is different

RPM (Shopify Collabs) doesn't expose individual transactions. Instead the scraper:
1. Reads cumulative `Sales` and `Earned` from the analytics page
2. Compares to the previous run's value (stored in `RPM Commissions`)
3. Writes the **delta** as a new row in the main `Comissions` tab
4. Each night the EOD job reconciles: it reads the day's full delta, sums what was already written intraday, and writes a single "gap" row if any commission is unaccounted for

Commission rate for RPM is hardcoded at **40%** (`COMMISSION_RATE = 0.40` in `rpm-eod-snapshot.yml`).

### Authentication strategies

Different platforms use different login mechanisms — the scrapers handle them differently:

| Platform | Auth method |
|---|---|
| BixGrow | Email/password → captures JWT, then direct API calls |
| SocialSnowball, Shortly | Standard email/password login via Puppeteer |
| UpPromote, Affiliatly | Login has reCAPTCHA. Cookie persistence first; 2Captcha fallback for unattended runs |
| GoAffPro | Standard login, but isolated Puppeteer instance to avoid frame-detach errors |
| RPM (Shopify Collabs) | **Cookies only** — hCaptcha on login is unsolvable. Refresh from Chrome via Cookie-Editor extension |
| Refersion (Gearbox/ERNE/Volair) | reCAPTCHA + email magic link → **manual only** (see `docs/MANUAL_NETWORKS.md`). The scraper uses pre-saved cookies. |

Cookies live in each package's `.cookies/` folder, are cached across GH Actions runs, and old caches are auto-deleted after 7 days.

---

## 6. Scheduling

- **Main scrape:** `.github/workflows/scrape-and-upload.yml` runs on cron 7am–11:45pm Central (13 runs/day in CDT). Every 1.5 hours through 10pm, then 11pm and 11:45pm. GH Actions cron has no timezone support so the schedule slides 1 hour earlier in CST.
- **RPM EOD snapshot:** `.github/workflows/rpm-eod-snapshot.yml` fires at 11:59pm Central every day. Two crons handle CDT (`59 4 * * *`) and CST (`59 5 * * *`). It reconciles the day's RPM commission and writes the closing snapshot.
- **Migration:** `.github/workflows/migrate-dates.yml` is `workflow_dispatch` only — a one-time tool, do not schedule.
- **Drift audit:** `.github/workflows/drift-audit.yml` runs at 11:50pm Central daily. Snapshots per-brand row count + commission total into the `Drift Audit` sheet tab, compares to the prior day, Slack-alerts if any brand lost more than 5 rows AND 5% (or $100 AND 5% commission). Defense-in-depth — catches a silently-broken reconcile flow that the safety guard didn't trip. If you see a drift alert: check the most recent scrape's logs first (a SAFETY GUARD warning explains it), then check if a scraper bug caused legitimate-looking rows to get over-deleted.

Each scraper runs in its own subshell so one failure doesn't block the rest. Failures notify Slack `#tech` via `SLACK_WEBHOOK_URL`. The job also pre-checks **cookie expiry** (warns if any cookie expires within 7 days) and **2Captcha balance** (warns at $5, critical at $1).

---

## 7. Conventions & rules

These reflect how the codebase is built and how Dane wants to keep it. Follow them by default; ask before deviating.

- **Money in cents.** Amounts are always integers. Looker has calculated fields `sale_dollars` / `commission_dollars` for display.
- **Dates in Central time, formatted `YYYY-MM-DD HH:MM:SS`.** This is a hard rule that anything touching dates must respect. Use `formatDateCentral` from `@kitchen/shared/transformer` to produce the canonical string — never hand-format dates inline. The function asserts its output matches the canonical regex and warns if it doesn't, so a future scraper bug can't silently corrupt the sheet again. `formatDateUTC` still exists as a deprecated alias for any forgotten callers — do not introduce new uses. The Looker `order_date_local` field must NOT apply a `timezone_offset` shift since the data is already local; see `docs/LOOKER_STUDIO.md`.
- **Status normalized to 3 values:** `pending`, `approved`, `declined`. The shared transformer maps platform-specific labels.
- **The sheet mirrors the source platform.** Every scraper uses `reconcileToSheets` from `@kitchen/shared/sheets`, which does a three-way diff against the platform's full current state: INSERT new rows, UPDATE changed rows, DELETE rows that no longer exist at the source. Append-only semantics caused inflated dashboard totals because cancelled/refunded sales accumulated as ghost rows (May 2026 incident: 53 ghosts on Honolulu alone). The reconcile flow includes a safety guard: if the source's count for an advertiser is less than 50% of the existing sheet rows AND there are more than 5 existing rows, the DELETE step is skipped and a warning is logged — this prevents a partial-scrape bug or auth failure from nuking real data. RPM is the exception: it writes generated delta rows that don't have a 1:1 source-of-truth mapping, so it stays on `uploadToSheets`. Refersion is also `uploadToSheets` for now because its scraper only reads the visible page (no pagination).
- **Dedupe on `transaction_id`.** Never write a row whose ID already exists. For platforms without a stable ID, generate `gen_<sha256-prefix>` from a deterministic input.
- **One scraper per package, one entry point.** `src/index.js` is the runner; `src/scraper.js` does the platform-specific work; `src/config.js` holds field mappings and account configs.
- **Use the shared package** (`@kitchen/shared`) for transformer, sheets upload, and base scraper logic. Don't duplicate.
- **Library preferences:**
  - Puppeteer for browser automation (already installed; don't add Playwright)
  - `googleapis` for Sheets (already used by shared)
  - `2captcha-ts` style flow for reCAPTCHA where supported
  - Avoid adding new heavy deps without a reason
- **Error handling style:** scrapers log loudly, save an error screenshot (`error-screenshot-*.png`) and a diagnostic JSON, and exit non-zero so the runner script can mark them failed. Don't swallow errors.
- **Naming:** brand slugs are lowercase ASCII (`luzz`, `pickleballapes`, `11six24`). Cookie files: `<slug>-cookies.json`. JSON dumps: `<platform>-<slug>-commissions-YYYY-MM-DD.json` (already gitignored).
- **No new docs files unless asked.** Keep info in this CLAUDE.md or in package READMEs. The root `README.md` was deleted intentionally — `.github/README.md` is the canonical one.

---

## 8. Known gotchas

Things that have bitten us before. Check here before debugging from scratch.

- **Sheet tab is named `Comissions` (one M).** Don't "fix" the typo — it'll break every scraper.
- **Looker `order_date_local` must not apply a timezone shift.** The data in the sheet is already in Central time. The original `order_date_local` formula included `DATETIME_ADD(... INTERVAL timezone_offset HOUR)` from back when the scrapers wrote UTC; when the scrapers were switched to Central (commit `db98525`) the Looker formula was not updated, causing late-night/early-morning sales to bucket into the wrong day and inflating daily totals by hundreds-to-thousands of dollars (Jared spotted this 2026-05-10). The correct formula is `PARSE_DATETIME("%Y-%m-%d %H:%M:%S", order_date)` with no shift. If anyone ever adds a `timezone_offset` parameter back, it must be 0. Full context in `docs/LOOKER_STUDIO.md`.
- **Looker `order_date` must be set to Text type** in the Sheets data source. If it's set to "Date & Time", Looker auto-mangles the value before `PARSE_DATETIME` sees it and charts go blank. See `docs/LOOKER_STUDIO.md`.
- **Date normalization is centralized.** Always use `formatDateCentral` from the shared package. The function refuses to return a string that doesn't match `YYYY-MM-DD HH:MM:SS`. `packages/shared/src/migrate-dates.js` is idempotent and can be re-run via the `Migrate dates to Central time` workflow if any non-canonical strings ever appear in the sheet — it leaves canonical rows alone and only touches stragglers.
- **RPM cookies expire and there's no auto-refresh.** When the workflow Slack-warns about expiring RPM cookies: log into collabs.shopify.com in Chrome (check "Stay signed in") → Cookie-Editor extension → "Export → JSON" → paste into Claude Code → `! pbpaste > packages/rpm/.cookies/rpm-cookies.json` → commit and push. The workflow's cookie cache is now save-on-success-only (commit `<set after this commit>`), so committed cookies take effect on the very next run. If you ever DO have to manually clear the cache, run `gh cache list --repo wdaneiliff-kitchen/kitchen-affiliate-scraper --key "Linux-session-cookies-v1-" | awk '{print $1}' | xargs -I{} gh cache delete {} --repo wdaneiliff-kitchen/kitchen-affiliate-scraper`.
- **Refersion can't be scraped headlessly.** reCAPTCHA + email magic link. The scraper relies on pre-saved cookies; when those expire someone has to log in manually (see `docs/MANUAL_NETWORKS.md`) and refresh cookies.
- **Ghost rows / inflated past days.** Until 2026-05-10, scrapers were append-only — a sale created in `pending`, later cancelled/refunded at the source, would stay in the sheet forever. Honolulu had 53 ghost rows accumulated since January. Jared spotted "past days seem inflated" and was right. Now fixed: see "the sheet mirrors the source platform" rule above. The safety guard prevents a partial scrape from cascading into mass deletion. If you ever see the safety-guard warning in Slack/logs, it means the scraper returned suspiciously few records for a brand — investigate before forcing a manual fix.
- **Manual RPM backfill on 2026-05-11.** RPM cookies expired May 9 and the scraper was down for ~3 days. To avoid one inflated "catch-up" day, the $737.54 / 14-sale gap was averaged across May 9, 10, 11 — three near-identical rows in `Comissions` with transaction IDs `gen_rpm_backfill_20260509/10/11`. The `RPM Commissions` tracking tab got a single sync entry with cumulative 795 / $60,966.98 so the next live scrape sees delta=0. `RPM Daily Snapshots` was updated to reflect intermediate cumulative state on May 9 (786 / $60,475.29) and May 10 (791 / $60,721.14), and the stale May 11 snapshot was deleted so tonight's EOD would write a fresh one. If you ever see those three identical-looking backfill rows and wonder where they came from — this is why. Lifetime $ is correct; per-day distribution for that window is approximated.
- **The hour=24 midnight bug.** Some Node.js versions return `"24"` for midnight when using `Intl.DateTimeFormat` with `hour: '2-digit', hour12: false` in the en-US locale. It was patched in `rpm/sheets.js` `nowCentral()` (commit `9d10008`) but the same fix never made it into the shared `formatDateComponents` in `transformer.js`, so every other scraper kept silently writing `YYYY-MM-DD 24:MM:SS` strings at midnight. 64 such rows accumulated in the sheet over months. Looker can't parse hour=24, so those rows silently dropped from the dashboard. **Now fixed on 2026-05-10:** both code paths clamp hour=24→00, and the canonical-date regex in `transformer.js` and `migrate-dates.js` actually validates time ranges so this can't slip through again. If you ever see a `24:MM:SS` date appear again, re-run the migration workflow.
- **Proton commission is 50% of sale amount** (UpPromote doesn't expose it directly). Hardcoded — see commit `fdd8224`.
- **Aireo commission is 25%.** Set as `commissionRate: 0.25` in `packages/uppromote/src/config.js`. The override only applies when UpPromote reports $0 commission, so it's a safety net rather than a forced override.
- **GoAffPro used to fail with "navigating frame was detached".** Fixed by using an isolated Puppeteer instance (commit `fcb2d54`). Don't merge it back into the shared browser.
- **EOD snapshot job needs a baseline.** If `RPM Daily Snapshots` is empty, the gap calculation is skipped (commit `2ebc7f3`) — write a baseline row manually before relying on it.
- **EOD snapshot job must not flip the day when it fires late.** The crons fire at 11:59pm Central, but GitHub Actions schedules can be delayed an hour or more, AND the CST cron always lands at 00:59 Central during CDT season. Originally the script computed `centralDate` from "now", so any post-midnight fire silently reconciled the wrong calendar day. Bit us on 2026-05-12: the CDT cron was delayed until 02:39am Central and the script wrote May 11's totals as a single $309.59 row dated May 12 — Jared noticed the lump appearing on "today" that morning. Fix landed same day: the script now detects an early-morning fire (Central hour < 6) and reconciles **yesterday** instead, stamping both the gap row's `order_date` and the snapshot's `recorded_at` as `YYYY-MM-DD 23:59:SS` of the day being closed out. If a future schedule slip ever pushes the job past 6am Central this would still misbehave — extremely unlikely but worth knowing.
- **Migration script must run inside the `shared` package** (where `googleapis` lives) — see commit `1060976`.
- **Node 24 opt-in:** workflows set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` to silence GH's Node 16 deprecation warning. Don't remove unless you know what you're replacing it with.

---

## 9. Current state & WIP

As of 2026-05-08:

- All scrapers are operational. Local env complete (`.env`, `credentials.json`, `gh` CLI auth'd as `wdaneiliff-kitchen`, `pnpm` global).
- Most recent work has been on RPM Pickleball: the EOD reconciliation workflow was added, then patched twice (tab-creation order, then baseline guard). See commits `4b8d5dc` → `2ebc7f3`.
- Slack alerts now cover failures, cancellations, low 2Captcha balance, and expiring cookies — all routed to `#tech`.
- The root `README.md` was deleted (`.github/README.md` replaces it). A `pnpm scraper` shortcut was added to trigger a manual GH Actions run.
- Pending uncommitted state on `main` (per `git status`): cookie file refreshes for several UpPromote brands, RPM dashboard screenshot, Refersion error screenshots, and a `packages/shared/src/fix-proton-dates.js` one-off helper. Ask Dane before committing — some of these may be local-only.
- No active bugs known. Next likely work: whatever cookie/balance Slack alert fires next, or onboarding a new brand.

---

## 10. Session workflow

**At the start of every session:** read this file first.

**At the end of every session, before signing off:** remind Dane to ask for a CLAUDE.md update if anything new was figured out, decided, or built. Quick prompt template:

> "Anything from today worth saving to CLAUDE.md? (new gotcha, new convention, new scraper or workflow, change to how we do things)"

When updating CLAUDE.md, **edit the relevant section in place** rather than appending a changelog. Keep it tight — old, irrelevant notes should be removed, not buried. The point is that this file stays useful; a stale CLAUDE.md is worse than none.

If a memory in `~/.claude/projects/.../memory/` contradicts this file, **trust this file** and update the memory. CLAUDE.md is the authoritative project record; auto-memory is for cross-session user/feedback context.
