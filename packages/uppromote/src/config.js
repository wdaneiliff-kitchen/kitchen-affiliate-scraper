/**
 * UpPromote-specific configuration for the transformer
 *
 * Supports multiple brands:
 * - Luzz
 * - Honolulu
 * - Holbrook
 * - Diadem
 * - Pickleball Apes
 *
 * Each brand has its own UpPromote shop URL and credentials.
 */

// Network (platform) identifier
export const NETWORK_ID = 'uppromote';

/**
 * Account configurations for different brands
 * Uses environment variables for credentials and URLs
 */
// Shared credentials for all UpPromote accounts
const EMAIL = process.env.UPPROMOTE_EMAIL;
const PASSWORD = process.env.UPPROMOTE_PASSWORD;

// These are public affiliate portal URLs, not secrets.
// Keep env overrides for flexibility in CI/local testing.
const ACCOUNT_BASE_URLS = {
  luzz: 'https://af.uppromote.com/010661-db',
  honolulu: 'https://af.uppromote.com/4009c8-2',
  holbrook: 'https://ambassadors.holbrookpickleball.com',
  diadem: 'https://af.uppromote.com/diademsports',
  pickleballapes: 'https://af.uppromote.com/pickleballapes',
};

function resolveBaseUrl(accountName) {
  const envKey = `UPPROMOTE_${accountName.toUpperCase()}_BASE_URL`;
  return process.env[envKey] || ACCOUNT_BASE_URLS[accountName];
}

export function getAccount(name) {
  const accounts = {
    luzz: {
      email: EMAIL,
      password: PASSWORD,
      baseUrl: resolveBaseUrl('luzz'),
      advertiserId: 'luzz',
      advertiserName: 'Luzz',
    },
    honolulu: {
      email: EMAIL,
      password: PASSWORD,
      baseUrl: resolveBaseUrl('honolulu'),
      advertiserId: 'honolulu',
      advertiserName: 'Honolulu',
    },
    holbrook: {
      email: EMAIL,
      password: PASSWORD,
      baseUrl: resolveBaseUrl('holbrook'),
      advertiserId: 'holbrook',
      advertiserName: 'Holbrook',
    },
    diadem: {
      email: EMAIL,
      password: PASSWORD,
      baseUrl: resolveBaseUrl('diadem'),
      advertiserId: 'diadem',
      advertiserName: 'Diadem',
    },
    pickleballapes: {
      email: EMAIL,
      password: PASSWORD,
      baseUrl: resolveBaseUrl('pickleballapes'),
      advertiserId: 'pickleballapes',
      advertiserName: 'Pickleball Apes',
    },
  };
  return accounts[name];
}

export const ACCOUNT_NAMES = ['luzz', 'honolulu', 'holbrook', 'diadem', 'pickleballapes'];

// Default account
export const DEFAULT_ACCOUNT = 'luzz';

// UpPromote status mappings
// String-based statuses (standard transformer handles most)
export const STATUS_MAPPINGS = {
  // Add any numeric status codes here if UpPromote uses them
};

// Common field name mappings from UpPromote to target schema
export const FIELD_MAPPINGS = {
  // Transaction ID - UpPromote uses referral_id
  transaction_id: ['referral_id', 'id', 'conversion_id'],

  // Date fields
  order_date: ['created_at', 'conversion_date', 'order_date', 'date'],
  click_date: ['click_date', 'clicked_at'],
  validation_date: ['approved_at', 'validated_at', 'paid_at'],
  modified_date: ['updated_at', 'modified_at'],

  // Currency
  currency_id: ['currency', 'currency_code', 'currency_id'],

  // Amounts - UpPromote: 'total_sales' is order amount, 'commission' is earnings
  sale_amount: ['total_sales', 'sale_amount', 'order_total', 'subtotal', 'amount'],
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
