/**
 * SocialSnowball-specific configuration for the transformer
 *
 * Note: Field mappings will be refined after discovering the actual API response structure.
 * Initial mappings are based on common patterns and the platform's terminology.
 */

// Network (platform) identifier
export const NETWORK_ID = 'socialsnowball';

// Advertiser config - the merchant you're an affiliate for
export const ADVERTISER_ID = process.env.ADVERTISER_ID || 'enhance';
export const ADVERTISER_NAME = process.env.ADVERTISER_NAME || 'Enhance Pickleball';

// Merchant name to select after login (must match dropdown option exactly)
export const MERCHANT_NAME = process.env.SOCIALSNOWBALL_MERCHANT || 'Enhance Pickleball';

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
// Based on actual API response from search-payables endpoint
export const FIELD_MAPPINGS = {
  // Transaction ID
  transaction_id: ['id'],

  // Date fields
  order_date: ['source_item_external_created_at', 'created_at'],
  click_date: [],
  validation_date: [],
  modified_date: [],

  // Currency
  currency_id: ['currency'],

  // Amounts are pre-processed and flattened in index.js
  sale_amount: ['_sale_amount'],
  commission_amount: ['_commission_amount'],

  // Status
  status: ['status'],

  // Sub IDs / tracking
  sub_id_1: ['source_item_attribution_value'],  // Discount code e.g. "KITCHEN"
  sub_id_2: ['affiliate_id'],
  sub_id_3: ['segment_id'],
  sub_id_4: [],
  sub_id_5: [],
  sub_id_6: [],

  // Other optional fields
  decline_reason: ['payout_failure_reason', 'status_description'],
  paid_to_publisher: [],
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
 * Extract commission amount from nested amount.value field
 * Values are in cents as strings (e.g., "464970" = $4649.70)
 */
export function extractCommissionAmount(record) {
  if (record.amount?.value) {
    return parseInt(record.amount.value, 10);
  }
  return 0;
}

/**
 * Extract sale amount from nested associated_revenue.value field
 * Values are in cents as strings
 */
export function extractSaleAmount(record) {
  if (record.associated_revenue?.value) {
    return parseInt(record.associated_revenue.value, 10);
  }
  // Fallback to commission base
  if (record.associated_commission_base?.value) {
    return parseInt(record.associated_commission_base.value, 10);
  }
  return 0;
}

