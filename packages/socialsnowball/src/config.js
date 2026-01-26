/**
 * SocialSnowball-specific configuration for the transformer
 *
 * Note: Field mappings will be refined after discovering the actual API response structure.
 * Initial mappings are based on common patterns and the platform's terminology.
 */

// Network (platform) identifier
export const NETWORK_ID = 'socialsnowball';

// Account configurations for different merchants
// Using a function to read env vars after dotenv has loaded
export function getAccount(name) {
  const accounts = {
    enhance: {
      email: process.env.SOCIALSNOWBALL_ENHANCE_EMAIL,
      password: process.env.SOCIALSNOWBALL_ENHANCE_PASSWORD,
      merchantName: 'Enhance Pickleball',
      advertiserId: 'enhance',
      advertiserName: 'Enhance Pickleball',
    },
    crbn: {
      email: process.env.SOCIALSNOWBALL_CRBN_EMAIL,
      password: process.env.SOCIALSNOWBALL_CRBN_PASSWORD,
      merchantName: 'CRBN',  // Adjust if dropdown shows different name
      advertiserId: 'crbn',
      advertiserName: 'CRBN',
    },
    friday: {
      email: process.env.SOCIALSNOWBALL_FRIDAY_EMAIL,
      password: process.env.SOCIALSNOWBALL_FRIDAY_PASSWORD,
      merchantName: 'Friday',  // Adjust if dropdown shows different name
      advertiserId: 'friday',
      advertiserName: 'Friday',
    },
  };
  return accounts[name];
}

export const ACCOUNT_NAMES = ['enhance', 'crbn', 'friday'];

// Default account (for backwards compatibility)
export const DEFAULT_ACCOUNT = 'enhance';

// SocialSnowball status mappings
// API returns: "created", "ready_for_payout", "paid", etc.
export const STATUS_MAPPINGS = {
  'created': 'pending',
  'ready_for_payout': 'approved',
  'ready': 'approved',
  'paid': 'approved',
  'pending': 'pending',
  'cancelled': 'declined',
  'refunded': 'declined',
};

// Field name mappings from SocialSnowball to target schema
// Handles multiple API formats:
// - Enhance: search-payables (uses source_item_external_created_at)
// - CRBN/Friday pending: payouts/pending (uses date)
// - CRBN/Friday paid: payouts/paid (uses order_date, payout_date)
export const FIELD_MAPPINGS = {
  // Transaction ID
  transaction_id: ['id'],

  // Date fields - different APIs use different field names
  // payouts/paid uses 'order_date' directly, others use different names
  order_date: ['order_date', 'source_item_external_created_at', 'date', 'created_at'],
  click_date: [],
  validation_date: ['payout_date'],  // Use payout_date as validation date for paid records
  modified_date: [],

  // Currency - extracted from nested objects in pre-processing
  currency_id: ['_currency', 'currency'],

  // Amounts are pre-processed and flattened in index.js
  sale_amount: ['_sale_amount'],
  commission_amount: ['_commission_amount'],

  // Status - different APIs use different field names
  // For paid endpoint, we'll set this in pre-processing
  status: ['_status', 'status', 'payout_status'],

  // Sub IDs / tracking
  sub_id_1: ['source_item_attribution_value'],  // Discount code e.g. "KITCHEN"
  sub_id_2: ['affiliate_id'],
  sub_id_3: ['segment_id'],
  sub_id_4: [],
  sub_id_5: [],
  sub_id_6: [],

  // Other optional fields
  decline_reason: ['payout_failure_reason', 'status_description', 'commission_pending_reason'],
  paid_to_publisher: ['ready'],  // boolean in CRBN format
  clickout_url: [],
  product_title: [],
  order_ref: ['source_item_external_id'],  // Shopify order ID
};

/**
 * Extract product title from SocialSnowball record
 */
export function extractProductTitle(record) {
  // SocialSnowball doesn't include product info in payout data
  return '';
}

/**
 * Extract commission amount from nested fields
 * Returns dollar value (NOT cents) - transformer will convert
 * Handles two formats:
 * - Enhance: amount.value (cents as string, e.g., "464970") - convert to dollars
 * - CRBN/Friday: commission.raw (dollars as number, e.g., 8.55)
 */
export function extractCommissionAmount(record) {
  // Enhance format: amount.value in cents - convert to dollars for transformer
  if (record.amount?.value) {
    return parseInt(record.amount.value, 10) / 100;
  }
  // CRBN/Friday format: commission.raw already in dollars
  if (record.commission?.raw !== undefined) {
    return record.commission.raw;
  }
  return 0;
}

/**
 * Extract sale amount from nested fields
 * Returns dollar value (NOT cents) - transformer will convert
 * Handles two formats:
 * - Enhance: associated_revenue.value (cents as string) - convert to dollars
 * - CRBN/Friday: referred_revenue.raw (dollars as number)
 */
export function extractSaleAmount(record) {
  // Enhance format: associated_revenue.value in cents - convert to dollars for transformer
  if (record.associated_revenue?.value) {
    return parseInt(record.associated_revenue.value, 10) / 100;
  }
  // Fallback to commission base (also in cents)
  if (record.associated_commission_base?.value) {
    return parseInt(record.associated_commission_base.value, 10) / 100;
  }
  // CRBN/Friday format: referred_revenue.raw already in dollars
  if (record.referred_revenue?.raw !== undefined) {
    return record.referred_revenue.raw;
  }
  return 0;
}

/**
 * Extract currency from nested fields
 */
export function extractCurrency(record) {
  return record.currency ||
         record.commission?.currency ||
         record.referred_revenue?.currency ||
         'USD';
}

