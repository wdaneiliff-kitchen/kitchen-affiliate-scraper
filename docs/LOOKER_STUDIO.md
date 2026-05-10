# Looker Studio – "The Kitchen" Dashboard

## Data Source

**Google Sheets → Looker Studio connector**

The scrapers write commission data to a single Google Sheet (`GOOGLE_SHEET_ID`). Looker Studio connects to this sheet as its data source ("Kitchen - Affiliate Data - Comi…").

### Source Columns (A–V)

These 22 columns are written by the shared transformer (`packages/shared/src/transformer.js`):

| Column | Field | Type | Notes |
|--------|-------|------|-------|
| A | `transaction_id` | Text | Natural ID from platform, or `gen_<hash>` |
| B | `advertiser_id` | Text | e.g. `luzz`, `enhance`, `joola` |
| C | `advertiser_name` | Text | Display name |
| D | `order_date` | Date & Time | `Y-m-d H:i:s` format, UTC |
| E | `currency_id` | Text | 3-letter ISO 4217 (e.g. `USD`) |
| F | `sale_amount` | Number | Amount in **cents** |
| G | `commission_amount` | Number | Amount in **cents** |
| H | `status` | Text | `pending`, `approved`, or `declined` |
| I | `click_date` | Date & Time | UTC, may be empty |
| J | `validation_date` | Date & Time | UTC, may be empty |
| K | `modified_date` | Date & Time | UTC, may be empty |
| L | `sub_id_1` | Text | Sub tracking ID |
| M | `sub_id_2` | Text | Often the landing page URL |
| N | `sub_id_3` | Text | |
| O | `sub_id_4` | Text | |
| P | `sub_id_5` | Text | |
| Q | `sub_id_6` | Text | |
| R | `decline_reason` | Text | |
| S | `paid_to_publisher` | Text | `1`, `0`, or empty |
| T | `clickout_url` | Text | |
| U | `product_title` | Text | |
| V | `order_ref` | Text | |

### Advertisers in the Data

| Advertiser ID | Advertiser Name | Platform | Package |
|---------------|-----------------|----------|---------|
| `enhance` | Enhance Pickleball | SocialSnowball | `socialsnowball` |
| `crbn` | CRBN | SocialSnowball | `socialsnowball` |
| `friday` | Friday | SocialSnowball | `socialsnowball` |
| `joola` | Joola | BixGrow | `bixgrow` |
| `engage` | Engage | Affiliatly | `affiliatly` |
| `luzz` | Luzz | UpPromote | `uppromote` |
| `honolulu` | Honolulu | UpPromote | `uppromote` |
| `holbrook` | Holbrook | UpPromote | `uppromote` |
| `diadem` | Diadem | UpPromote | `uppromote` |
| `pickleballapes` | Pickleball Apes | UpPromote | `uppromote` |
| `udrippin` | UDrippin | UpPromote | `uppromote` |
| `11six24` | 11six24 | UpPromote | `uppromote` |
| `vatic` | Vatic | UpPromote | `uppromote` |
| `gruvn` | Gruvn | UpPromote | `uppromote` |
| `sixzero` | Six Zero | UpPromote | `uppromote` |
| `neonic` | Neonic | UpPromote | `uppromote` |
| `chorus` | Chorus | UpPromote | `uppromote` |
| `thrive` | Thrive | UpPromote | `uppromote` |
| `mark` | Mark | UpPromote | `uppromote` |
| `gherkin` | Gherkin | UpPromote | `uppromote` |
| `aireo` | Aireo | UpPromote | `uppromote` |
| `paddletek` | Paddletek Pickleball | Shortly | `shortly` |
| `goaffpro-forwrd` | GoAffPro (Forwrd) | GoAffPro | `goaffpro` |
| `franklin` | Franklin | Impact | `impact` |

---

## Looker Calculated Fields

These fields are defined inside Looker Studio (not in the source sheet):

### `sale_dollars`

Converts `sale_amount` from cents to dollars.

```
sale_amount / 100
```

### `commission_dollars`

Converts `commission_amount` from cents to dollars.

```
commission_amount / 100
```

### `advertiser_url`

Likely a renamed reference to `sub_id_2` (which typically contains the landing page / advertiser URL).

### `order_date_local`

Parses `order_date` (already in Central time) into a DATETIME for charting.

**Current formula (correct as of 2026-05-10):**

```
PARSE_DATETIME("%Y-%m-%d %H:%M:%S", order_date)
```

**Important — historical context:** The scrapers used to write dates in UTC, and
this field used to apply `DATETIME_ADD(... INTERVAL timezone_offset HOUR)` to shift
UTC into local time. That stopped being correct in late April 2026 when:

1. The scrapers were changed to write dates directly in Central time (`America/Chicago`),
   commit `db98525`
2. All historical rows were migrated from UTC → Central via `migrate-dates.yml`,
   2026-05-02

After those changes, the data in the sheet is **already in Central time**, so any
non-zero shift in `order_date_local` (via a `timezone_offset` parameter or a hard-coded
`INTERVAL`) over-shifts dates and causes late-night/early-morning sales to bucket
into the wrong day. Symptom: daily totals in the dashboard run $300–$2000 higher than
reality, with the discrepancy biggest near day boundaries. (Diagnosed 2026-05-10
after Jared flagged inflated daily numbers.)

If the dashboard ever exposes a `timezone_offset` parameter again, it must be **0**.

**Prerequisite:** The `order_date` field must be set to **Text** type in the data
source configuration. The scrapers output dates as `YYYY-MM-DD HH:MM:SS` strings
(e.g. `2026-03-12 14:30:00`), and `PARSE_DATETIME` requires a Text input.

If `order_date` is set to "Date & Time (YYYYMMDDhhmmss)" instead, Looker tries to
auto-convert the value using the wrong format, which corrupts the data before
`PARSE_DATETIME` sees it — resulting in NULLs and "No data" in charts.

Use `order_date_local` as the report's date range dimension for charts and controls.
Using raw `order_date` caused tables and dropdown controls to appear blank even though
the underlying sheet data was present.

---

## Dashboard Structure

### Page 1 – Overview

**Controls (top bar):**

| Control | Connected Field | Notes |
|---------|----------------|-------|
| Date range picker | `order_date_local` | Default: last 2 days |
| Advertiser dropdown | `advertiser_name` or `advertiser_id` | Filter by brand |
| Timezone offset | `timezone_offset` | UTC offset parameter/field |
| Order Status | `status` | Filter by pending/approved/declined |

**Scorecards:**

| Metric | Calculation |
|--------|-------------|
| Total Sales | `SUM(sale_dollars)` |
| Total Commission | `SUM(commission_dollars)` |
| # of Sales | `COUNT(transaction_id)` or `AUT` metric |

**Table:**

| Dimension | Metric | Metric | Metric |
|-----------|--------|--------|--------|
| `advertiser_url` | # of Sales | Total Sales | Total Commission |

- Drill down enabled, default level: `advertiser_url`
- Date range dimension: `order_date_local`

---

## Important Notes

- **All dates are UTC.** The scrapers normalize all dates to UTC before upload.
  Use the `order_date_local` calculated field for both display and the report's
  date range dimension.
- **Amounts are in cents.** Use the `sale_dollars` and `commission_dollars`
  calculated fields for human-readable dollar values.
- **`timezone_offset` is not in the source data.** It must be defined as a Looker
  Studio parameter or separate field/data source for the `order_date_local` formula to work.
