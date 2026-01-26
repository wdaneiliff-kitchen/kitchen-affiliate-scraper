/**
 * Shortly-specific configuration for the transformer
 *
 * Note: Field mappings will be refined after discovering the actual API response structure.
 * Initial mappings are based on common patterns.
 */

// Network (platform) identifier
export const NETWORK_ID = 'shortly';

// Account configurations
// Using a function to read env vars after dotenv has loaded
export function getAccount(name) {
  const accounts = {
    paddletek: {
      email: process.env.SHORTLY_EMAIL,
      password: process.env.SHORTLY_PASSWORD,
      shopName: 'Paddletek Pickleball',
      advertiserId: 'paddletek',
      advertiserName: 'Paddletek Pickleball',
    },
    // Add more shops/accounts as needed:
    // anotherShop: {
    //   email: process.env.SHORTLY_EMAIL,
    //   password: process.env.SHORTLY_PASSWORD,
    //   shopName: 'Another Shop Name',
    //   advertiserId: 'another-shop',
    //   advertiserName: 'Another Shop',
    // },
  };
  return accounts[name];
}

export const ACCOUNT_NAMES = ['paddletek'];

// Default account
export const DEFAULT_ACCOUNT = 'paddletek';

// Shortly status mappings
export const STATUS_MAPPINGS = {
  'active': 'approved',
  'approved': 'approved',
  'pending': 'pending',
  'paid': 'approved',
  'unpaid': 'approved',
  'partially refunded': 'declined',
  'refunded': 'declined',
  'cancelled': 'declined',
  'declined': 'declined',
  'rejected': 'declined',
};

// Field name mappings from Shortly to target schema
// Note: Shortly's DOM table has "commmission" misspelled with 3 m's
export const FIELD_MAPPINGS = {
  // Transaction ID - use order_no. as unique identifier
  transaction_id: ['order_no.', 'id', 'transaction_id', 'conversion_id'],

  // Date fields
  order_date: ['date', 'created_at', 'conversion_date', 'order_date'],
  click_date: ['click_date', 'clicked_at'],
  validation_date: ['validated_at', 'validation_date'],
  modified_date: ['updated_at', 'modified_at'],

  // Currency - extracted from amount strings in pre-processing
  currency_id: ['_currency', 'currency', 'currency_code'],

  // Amounts - pre-processed to extract from "USD XX.XX" strings
  sale_amount: ['_sale_amount'],
  commission_amount: ['_commission_amount'],

  // Status
  status: ['status', 'payout_status', 'conversion_status'],

  // Sub IDs / tracking
  sub_id_1: ['referral', 'sub_id', 'sub_id_1', 'tracking_id'],
  sub_id_2: ['sub_id_2', 'affiliate_id'],
  sub_id_3: ['sub_id_3'],
  sub_id_4: ['sub_id_4'],
  sub_id_5: ['sub_id_5'],
  sub_id_6: ['sub_id_6'],

  // Other optional fields
  decline_reason: ['decline_reason', 'rejection_reason'],
  paid_to_publisher: ['paid', 'is_paid'],
  clickout_url: ['url', 'destination_url'],
  product_title: ['product', 'product_name', 'item'],
  order_ref: ['order_no.', 'order_id', 'order_ref', 'reference'],
};

/**
 * Extract product title from Shortly record
 */
export function extractProductTitle(record) {
  return record.product || record.product_name || record.item || '';
}

/**
 * Parse a currency string like "USD 14.4" or "USD 77.85"
 * Returns the numeric dollar value (transformer will convert to cents)
 */
function parseCurrencyString(str) {
  if (!str || typeof str !== 'string') return 0;

  // Extract numeric value from strings like "USD 14.4" or "USD 77.85"
  // Also handle strings with newlines like "USD 193.36\nRefunded: USD 174.99"
  const firstLine = str.split('\n')[0].trim();
  const match = firstLine.match(/[\d,]+\.?\d*/);
  if (match) {
    const parsed = parseFloat(match[0].replace(/,/g, ''));
    if (!isNaN(parsed)) {
      return parsed; // Return dollar value, transformer handles cents conversion
    }
  }
  return 0;
}

/**
 * Extract commission amount
 * Returns dollar value (transformer converts to cents)
 * Note: Shortly misspells "commission" as "commmission" (3 m's) in their table
 */
export function extractCommissionAmount(record) {
  // Try the misspelled field first, then correct spelling
  const amount = record.commmission || record.commission || record.commission_amount || record.payout || record.amount;

  if (typeof amount === 'number') {
    return amount;
  }

  if (typeof amount === 'string') {
    return parseCurrencyString(amount);
  }

  return 0;
}

/**
 * Extract sale amount (revenue)
 * Returns dollar value (transformer converts to cents)
 */
export function extractSaleAmount(record) {
  // Shortly uses "revenue" field for sale amount
  const amount = record.revenue || record.sale_amount || record.order_amount || record.subtotal || record.order_value;

  if (typeof amount === 'number') {
    return amount;
  }

  if (typeof amount === 'string') {
    return parseCurrencyString(amount);
  }

  return 0;
}

/**
 * Extract currency from record
 * Shortly format: "USD 77.85" - extract the currency code
 */
export function extractCurrency(record) {
  // Try to extract from revenue or commission strings
  const amountStr = record.revenue || record.commmission || record.commission || '';
  if (typeof amountStr === 'string') {
    const match = amountStr.match(/^([A-Z]{3})\s/);
    if (match) return match[1];
  }
  return record.currency || record.currency_code || 'USD';
}

