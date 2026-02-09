/**
 * Affiliatly-specific configuration for the transformer
 *
 * Affiliatly is a simple affiliate tracking platform.
 * Login URL: https://www.affiliatly.com/login.html?affiliates=1
 * The dashboard shows affiliate commissions in a table format.
 */

// Network (platform) identifier
export const NETWORK_ID = 'affiliatly';

// Account configurations
export function getAccount(name) {
  const accounts = {
    engage: {
      email: process.env.AFFILIATLY_EMAIL,
      password: process.env.AFFILIATLY_PASSWORD,
      advertiserId: 'engage',
      advertiserName: 'Engage',
    },
  };
  return accounts[name];
}

export const ACCOUNT_NAMES = ['engage'];

// Default account
export const DEFAULT_ACCOUNT = 'engage';

// Affiliatly status mappings
export const STATUS_MAPPINGS = {
  'approved': 'approved',
  'confirmed': 'approved',
  'paid': 'approved',
  'unpaid': 'approved',
  'pending': 'pending',
  'waiting': 'pending',
  'declined': 'declined',
  'rejected': 'declined',
  'cancelled': 'declined',
  'refunded': 'declined',
  'void': 'declined',
};

// Field name mappings from Affiliatly to target schema
export const FIELD_MAPPINGS = {
  // Transaction ID
  transaction_id: ['order_id', 'id', 'transaction_id', 'order_number', 'order_no', 'order #', 'order'],

  // Date fields
  order_date: ['date', 'order_date', 'created_at', 'created', 'order date'],
  click_date: ['click_date', 'clicked_at'],
  validation_date: ['validated_at', 'validation_date', 'approved_date'],
  modified_date: ['updated_at', 'modified_at'],

  // Currency
  currency_id: ['currency', 'currency_code', '_currency'],

  // Amounts  ("price" is the Affiliatly column name for the order total)
  sale_amount: ['_sale_amount', 'price', 'sale_amount', 'order_amount', 'order_total', 'order amount', 'total', 'revenue', 'amount'],
  commission_amount: ['_commission_amount', 'commission_amount', 'commission', 'payout', 'earnings', 'affiliate commission'],

  // Status
  status: ['status', 'order_status', 'commission_status', 'payment_status'],

  // Sub IDs / tracking  ("tracking_method" and "landing_page" are Affiliatly column names)
  sub_id_1: ['affiliate', 'affiliate_name', 'affiliate_id', 'referral', 'sub_id_1', 'tracking_method'],
  sub_id_2: ['sub_id_2', 'coupon', 'coupon_code', 'landing_page'],
  sub_id_3: ['sub_id_3'],
  sub_id_4: ['sub_id_4'],
  sub_id_5: ['sub_id_5'],
  sub_id_6: ['sub_id_6'],

  // Other optional fields
  decline_reason: ['decline_reason', 'rejection_reason'],
  paid_to_publisher: ['paid', 'is_paid', 'paid_to_publisher'],
  clickout_url: ['url', 'destination_url', 'referral_url', 'referring_page'],
  product_title: ['product', 'product_name', 'product_title', 'item', 'items'],
  order_ref: ['order_id', 'order_number', 'order_ref', 'reference', 'order #', 'order'],
};

/**
 * Extract product title from Affiliatly record
 */
export function extractProductTitle(record) {
  return record.product || record.product_name || record.product_title || record.item || record.items || '';
}

/**
 * Parse a currency string like "$14.40" or "14.40 USD"
 * Returns the numeric dollar value (transformer will convert to cents)
 */
function parseCurrencyString(str) {
  if (!str || typeof str !== 'string') return 0;

  const cleaned = str.replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
  const parsed = parseFloat(cleaned);
  if (!isNaN(parsed)) {
    return parsed;
  }
  return 0;
}

/**
 * Extract commission amount from record
 * Returns dollar value (transformer converts to cents)
 */
export function extractCommissionAmount(record) {
  const amount = record.commission || record.commission_amount || record['affiliate commission'] ||
                 record.payout || record.earnings || record.amount;

  if (typeof amount === 'number') return amount;
  if (typeof amount === 'string') return parseCurrencyString(amount);
  return 0;
}

/**
 * Extract sale amount (order total) from record
 * Returns dollar value (transformer converts to cents)
 */
export function extractSaleAmount(record) {
  const amount = record.price || record.order_amount || record.order_total || record['order amount'] ||
                 record.total || record.revenue || record.sale_amount || record.amount;

  if (typeof amount === 'number') return amount;
  if (typeof amount === 'string') return parseCurrencyString(amount);
  return 0;
}

/**
 * Extract currency from record
 */
export function extractCurrency(record) {
  if (record.currency || record.currency_code) {
    return record.currency || record.currency_code;
  }

  // Try to extract currency symbol from amount strings
  const amountStr = record.price || record.earnings || record.order_amount || record.commission || record.total || '';
  if (typeof amountStr === 'string') {
    if (amountStr.includes('$')) return 'USD';
    if (amountStr.includes('€')) return 'EUR';
    if (amountStr.includes('£')) return 'GBP';
    const match = amountStr.match(/^([A-Z]{3})\s/);
    if (match) return match[1];
  }

  return 'USD';
}
