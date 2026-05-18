/**
 * UpPromote-specific configuration for the transformer
 *
 * Supports multiple brands:
 * - Luzz
 * - Honolulu
 * - Holbrook
 * - Diadem
 * - Pickleball Apes
 * - UDrippin
 * - 11six24
 * - Vatic
 * - Gruvn
 * - Six Zero
 * - Neonic
 * - Chorus
 * - Thrive
 * - Mark
 * - Gherkin
 * - Proton
 * - Aireo
 *
 * Each brand has its own UpPromote shop URL and credentials.
 */

// Network (platform) identifier
export const NETWORK_ID = 'uppromote';

/**
 * Account configurations for different brands
 * Uses environment variables for credentials and URLs
 */
function resolveCredential(accountName, field) {
  const envKey = `UPPROMOTE_${accountName.toUpperCase()}_${field}`;
  if (process.env[envKey]) {
    return process.env[envKey];
  }
  // Read shared fallback credentials at call time so .env loading order does not matter.
  return field === 'EMAIL' ? process.env.UPPROMOTE_EMAIL : process.env.UPPROMOTE_PASSWORD;
}

// These are public affiliate portal URLs, not secrets.
// Keep env overrides for flexibility in CI/local testing.
const ACCOUNT_BASE_URLS = {
  luzz: 'https://af.uppromote.com/010661-db',
  honolulu: 'https://af.uppromote.com/4009c8-2',
  holbrook: 'https://ambassadors.holbrookpickleball.com/holbrookpickleball',
  diadem: 'https://af.uppromote.com/diademsports',
  pickleballapes: 'https://af.uppromote.com/pickleballapes',
  udrippin: 'https://af.uppromote.com/Udrippin',
  '11six24': 'https://af.uppromote.com/11six24-pickleball',
  vatic: 'https://af.uppromote.com/vatic-pro',
  gruvn: 'https://af.uppromote.com/gruvn',
  sixzero: 'https://af.uppromote.com/six-zero-7668',
  neonic: 'https://af.uppromote.com/neonic-pickleball',
  chorus: 'https://af.uppromote.com/647c98-4',
  thrive: 'https://af.uppromote.com/thrive-pickleball',
  mark: 'https://af.uppromote.com/495311-2',
  gherkin: 'https://af.uppromote.com/GherkinUSA',
  proton: 'https://af.uppromote.com/proton-sports-inc',
  aireo: 'https://af.uppromote.com/qm0wg4-ay',
};

function resolveBaseUrl(accountName) {
  const envKey = `UPPROMOTE_${accountName.toUpperCase()}_BASE_URL`;
  return process.env[envKey] || ACCOUNT_BASE_URLS[accountName];
}

export function getAccount(name) {
  const accounts = {
    luzz: {
      email: resolveCredential('luzz', 'EMAIL'),
      password: resolveCredential('luzz', 'PASSWORD'),
      baseUrl: resolveBaseUrl('luzz'),
      advertiserId: 'luzz',
      advertiserName: 'Luzz',
    },
    honolulu: {
      email: resolveCredential('honolulu', 'EMAIL'),
      password: resolveCredential('honolulu', 'PASSWORD'),
      baseUrl: resolveBaseUrl('honolulu'),
      advertiserId: 'honolulu',
      advertiserName: 'Honolulu',
    },
    holbrook: {
      email: resolveCredential('holbrook', 'EMAIL'),
      password: resolveCredential('holbrook', 'PASSWORD'),
      baseUrl: resolveBaseUrl('holbrook'),
      advertiserId: 'holbrook',
      advertiserName: 'Holbrook',
    },
    diadem: {
      email: resolveCredential('diadem', 'EMAIL'),
      password: resolveCredential('diadem', 'PASSWORD'),
      baseUrl: resolveBaseUrl('diadem'),
      advertiserId: 'diadem',
      advertiserName: 'Diadem',
    },
    pickleballapes: {
      email: resolveCredential('pickleballapes', 'EMAIL'),
      password: resolveCredential('pickleballapes', 'PASSWORD'),
      baseUrl: resolveBaseUrl('pickleballapes'),
      advertiserId: 'pickleballapes',
      advertiserName: 'Pickleball Apes',
    },
    udrippin: {
      email: resolveCredential('udrippin', 'EMAIL'),
      password: resolveCredential('udrippin', 'PASSWORD'),
      baseUrl: resolveBaseUrl('udrippin'),
      advertiserId: 'udrippin',
      advertiserName: 'UDrippin',
    },
    '11six24': {
      email: resolveCredential('11six24', 'EMAIL'),
      password: resolveCredential('11six24', 'PASSWORD'),
      baseUrl: resolveBaseUrl('11six24'),
      advertiserId: '11six24',
      advertiserName: '11six24',
    },
    vatic: {
      email: resolveCredential('vatic', 'EMAIL'),
      password: resolveCredential('vatic', 'PASSWORD'),
      baseUrl: resolveBaseUrl('vatic'),
      advertiserId: 'vatic',
      advertiserName: 'Vatic',
    },
    gruvn: {
      email: resolveCredential('gruvn', 'EMAIL'),
      password: resolveCredential('gruvn', 'PASSWORD'),
      baseUrl: resolveBaseUrl('gruvn'),
      advertiserId: 'gruvn',
      advertiserName: 'Gruvn',
    },
    sixzero: {
      email: resolveCredential('sixzero', 'EMAIL'),
      password: resolveCredential('sixzero', 'PASSWORD'),
      baseUrl: resolveBaseUrl('sixzero'),
      advertiserId: 'sixzero',
      advertiserName: 'Six Zero',
    },
    neonic: {
      email: resolveCredential('neonic', 'EMAIL'),
      password: resolveCredential('neonic', 'PASSWORD'),
      baseUrl: resolveBaseUrl('neonic'),
      advertiserId: 'neonic',
      advertiserName: 'Neonic',
    },
    chorus: {
      email: resolveCredential('chorus', 'EMAIL'),
      password: resolveCredential('chorus', 'PASSWORD'),
      baseUrl: resolveBaseUrl('chorus'),
      advertiserId: 'chorus',
      advertiserName: 'Chorus',
    },
    thrive: {
      email: resolveCredential('thrive', 'EMAIL'),
      password: resolveCredential('thrive', 'PASSWORD'),
      baseUrl: resolveBaseUrl('thrive'),
      advertiserId: 'thrive',
      advertiserName: 'Thrive',
    },
    mark: {
      email: resolveCredential('mark', 'EMAIL'),
      password: resolveCredential('mark', 'PASSWORD'),
      baseUrl: resolveBaseUrl('mark'),
      advertiserId: 'mark',
      advertiserName: 'Mark',
    },
    gherkin: {
      email: resolveCredential('gherkin', 'EMAIL'),
      password: resolveCredential('gherkin', 'PASSWORD'),
      baseUrl: resolveBaseUrl('gherkin'),
      advertiserId: 'gherkin',
      advertiserName: 'Gherkin',
    },
    proton: {
      email: resolveCredential('proton', 'EMAIL'),
      password: resolveCredential('proton', 'PASSWORD'),
      baseUrl: resolveBaseUrl('proton'),
      advertiserId: 'proton',
      advertiserName: 'Proton',
      commissionRate: 0.50,
    },
    aireo: {
      email: resolveCredential('aireo', 'EMAIL'),
      password: resolveCredential('aireo', 'PASSWORD'),
      baseUrl: resolveBaseUrl('aireo'),
      advertiserId: 'aireo',
      advertiserName: 'Aireo',
      commissionRate: 0.25,
    },
  };
  return accounts[name];
}

export const ACCOUNT_NAMES = ['luzz', 'honolulu', 'holbrook', 'diadem', 'pickleballapes', 'udrippin', '11six24', 'vatic', 'gruvn', 'sixzero', 'neonic', 'chorus', 'thrive', 'mark', 'gherkin', 'proton', 'aireo'];

// Default account
export const DEFAULT_ACCOUNT = 'luzz';

// UpPromote numeric status code → canonical status. Verified 2026-05-17 by
// matching API records against existing sheet rows (368 rows across honolulu
// + luzz, 100% match). Values:
//   0 → "Pending" badge in UI (commission earned, not yet approved)
//   1 → "Approved" badge (approved, awaiting payout)
//   2 → "Paid" badge (payout sent — canonically "approved" per shared mapper)
// If UpPromote ever returns a new code, the shared transformer warns and
// defaults to "pending"; add it here when seen.
export const STATUS_MAPPINGS = {
  0: 'pending',
  1: 'approved',
  2: 'approved',
};

// Common field name mappings from UpPromote to target schema
export const FIELD_MAPPINGS = {
  // Transaction ID - the datatables/commission API returns `id` (referrals.id)
  // as the stable per-commission identifier. `referral_id` kept as fallback so
  // any cached JSON dumps from the legacy DOM extractor (which renamed `id` →
  // `referral_id`) still produce matching transaction_ids on re-upload.
  transaction_id: ['id', 'referral_id', 'conversion_id'],

  // Date fields - datatables API returns Unix timestamps; formatDateCentral handles them
  order_date: ['created_at', 'conversion_date', 'order_date', 'date'],
  click_date: ['click_date', 'clicked_at'],
  validation_date: ['approved_at', 'validated_at', 'paid_at'],
  modified_date: ['updated_at', 'modified_at'],

  // Currency
  currency_id: ['currency', 'currency_code', 'currency_id'],

  // Amounts - API: `total` is order amount, `commission` is earnings.
  // `total_sales` was the legacy DOM-scraped name; kept for backwards-compat.
  sale_amount: ['total', 'total_sales', 'sale_amount', 'order_total', 'subtotal', 'amount'],
  commission_amount: ['commission', 'commission_amount', 'earnings', 'payout'],

  // Status
  status: ['status', 'state', 'payout_status'],

  // Sub IDs - UpPromote tracking parameters
  sub_id_1: ['sub_id_1', 'subid1', 'click_id', 'tracking_id', 'affiliate_coupon'],
  sub_id_2: ['sub_id_2', 'subid2', 'utm_source'],
  sub_id_3: ['sub_id_3', 'subid3', 'utm_medium'],
  sub_id_4: ['sub_id_4', 'subid4', 'utm_campaign'],
  sub_id_5: ['sub_id_5', 'subid5'],
  sub_id_6: ['sub_id_6', 'subid6'],

  // Other optional fields
  decline_reason: ['decline_reason', 'rejection_reason', 'reason', 'cancel_reason'],
  paid_to_publisher: ['paid', 'is_paid', 'paid_to_publisher'],
  clickout_url: ['url', 'landing_url', 'referrer_url', 'destination_url'],
  product_title: ['product_title', 'product_name', 'item_name', 'product'],
  order_ref: ['order_number', 'order_name', 'order_ref', 'shopify_order_id', 'external_order_id'],
};

/**
 * Extracts product title from UpPromote's nested line_items structure
 * UpPromote may include line items with product details
 */
export function extractProductTitle(record) {
  // Try direct product_title field first
  const directFields = ['product_title', 'product_name', 'item_name', 'product'];
  for (const field of directFields) {
    if (record[field]) return record[field];
  }

  // UpPromote stores product info in line_items array
  const lineItems = record.line_items || record.items || record.products;
  if (lineItems?.length > 0) {
    const titles = lineItems
      .map(item => item.name || item.title || item.product_name || item.product_title)
      .filter(Boolean);
    return titles.join(', ');
  }

  return '';
}
