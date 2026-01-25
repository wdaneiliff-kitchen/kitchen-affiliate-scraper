/**
 * Transforms raw BixGrow commission data to the target Google Sheet schema.
 *
 * Target Schema:
 * - transaction_id (required): Unique identifier for the transaction
 * - advertiser_id (required): Unique identifier for the advertiser
 * - advertiser_name (required): Advertiser name
 * - order_date (required): Y-m-d H:i:s format in UTC
 * - currency_id (required): 3-letter ISO 4217 code
 * - sale_amount (required): Amount in cents
 * - commission_amount (required): Amount in cents
 * - status (required): 'pending' | 'approved' | 'declined'
 * - click_date (optional): Y-m-d H:i:s format in UTC
 * - validation_date (optional): Y-m-d H:i:s format in UTC
 * - modified_date (optional): Y-m-d H:i:s format in UTC
 * - sub_id_1..6 (optional): Sub tracking IDs
 * - decline_reason (optional): Why sale got declined
 * - paid_to_publisher (optional): '1' or '0'
 * - clickout_url (optional): Valid URL format
 * - product_title (optional): Product title
 * - order_ref (optional): Order reference
 */

// Advertiser config - set via environment variables or use defaults
const ADVERTISER_ID = process.env.ADVERTISER_ID || 'joola';
const ADVERTISER_NAME = process.env.ADVERTISER_NAME || 'Joola';

// Common field name mappings from BixGrow to target schema
const FIELD_MAPPINGS = {
  // Transaction ID variations
  transaction_id: ['transaction_id', 'transactionId', 'id', 'conversion_id', 'conversionId'],

  // Advertiser fields - BixGrow uses shop_id
  advertiser_id: ['advertiser_id', 'advertiserId', 'shop_id', 'merchant_id', 'merchantId', 'brand_id', 'brandId', 'program_id', 'programId'],
  advertiser_name: ['advertiser_name', 'advertiserName', 'merchant_name', 'merchantName', 'brand_name', 'brandName', 'program_name', 'programName'],

  // Date fields
  order_date: ['order_date', 'orderDate', 'created_at', 'createdAt', 'date', 'transaction_date', 'transactionDate', 'conversion_date', 'conversionDate'],
  click_date: ['click_date', 'clickDate', 'clicked_at', 'clickedAt'],
  validation_date: ['validation_date', 'validationDate', 'validated_at', 'validatedAt', 'approved_at', 'approvedAt'],
  modified_date: ['modified_date', 'modifiedDate', 'updated_at', 'updatedAt'],

  // Currency
  currency_id: ['currency_id', 'currencyId', 'currency', 'currency_code', 'currencyCode'],

  // Amounts - BixGrow: 'commission' is the calculated commission, 'total' is sale amount
  sale_amount: ['sale_amount', 'saleAmount', 'total', 'amount', 'order_amount', 'orderAmount', 'revenue', 'order_total', 'orderTotal', 'commissionable_sales'],
  commission_amount: ['commission', 'commission_amount', 'commissionAmount', 'payout', 'earnings'],

  // Status
  status: ['status', 'state', 'conversion_status', 'conversionStatus'],

  // Sub IDs - BixGrow uses click_id, tid1, tid2, tid3
  sub_id_1: ['sub_id_1', 'subId1', 'sub1', 'sid1', 'click_id', 'clickId'],
  sub_id_2: ['sub_id_2', 'subId2', 'sub2', 'sid2', 'tid1'],
  sub_id_3: ['sub_id_3', 'subId3', 'sub3', 'sid3', 'tid2'],
  sub_id_4: ['sub_id_4', 'subId4', 'sub4', 'sid4', 'tid3'],
  sub_id_5: ['sub_id_5', 'subId5', 'sub5', 'sid5'],
  sub_id_6: ['sub_id_6', 'subId6', 'sub6', 'sid6'],

  // Other optional fields - BixGrow uses order_name for order reference
  decline_reason: ['decline_reason', 'declineReason', 'rejection_reason', 'rejectionReason', 'reason', 'comment'],
  paid_to_publisher: ['paid_to_publisher', 'paidToPublisher', 'paid', 'is_paid', 'isPaid'],
  clickout_url: ['clickout_url', 'clickoutUrl', 'destination_url', 'destinationUrl', 'url', 'landing_url', 'landingUrl', 'referrer_url'],
  product_title: ['product_title', 'productTitle', 'product_name', 'productName', 'item_name', 'itemName', 'product'],
  order_ref: ['order_ref', 'orderRef', 'order_name', 'orderName', 'reference', 'ref', 'external_id', 'externalId'],
};

// Status value mappings to normalize different representations
const STATUS_MAPPINGS = {
  pending: ['pending', 'new', 'open', 'waiting', 'unconfirmed', '1'],
  approved: ['approved', 'confirmed', 'validated', 'active', 'complete', 'completed', 'paid', 'due', '6'],
  declined: ['declined', 'rejected', 'cancelled', 'canceled', 'void', 'voided', 'refunded', '2', '3'],
};

// BixGrow uses numeric status codes
const NUMERIC_STATUS_MAP = {
  1: 'pending',    // Pending approval
  2: 'declined',   // Rejected
  3: 'declined',   // Cancelled
  6: 'approved',   // Approved/Paid
};

/**
 * Transforms an array of raw BixGrow records to the target schema
 * @param {Array} rawRecords - Raw commission records from BixGrow
 * @returns {Array} Transformed records matching target schema
 */
export function transformRecords(rawRecords) {
  if (!Array.isArray(rawRecords)) {
    console.warn('transformRecords received non-array input:', typeof rawRecords);
    return [];
  }

  // Debug: log first record's fields to help with mapping
  if (rawRecords.length > 0 && process.env.DEBUG) {
    console.log('📋 Raw record fields:', Object.keys(rawRecords[0]).join(', '));
    console.log('📋 First raw record:', JSON.stringify(rawRecords[0], null, 2));
  }

  return rawRecords.map((record, index) => {
    try {
      return transformRecord(record);
    } catch (error) {
      console.warn(`Failed to transform record ${index}:`, error.message);
      return null;
    }
  }).filter(Boolean);
}

/**
 * Transforms a single raw record to the target schema
 * @param {Object} raw - Raw commission record
 * @returns {Object} Transformed record
 */
export function transformRecord(raw) {
  const transformed = {
    // Required fields
    transaction_id: findField(raw, FIELD_MAPPINGS.transaction_id) || generateTransactionId(raw),
    advertiser_id: ADVERTISER_ID,
    advertiser_name: ADVERTISER_NAME,
    order_date: formatDateUTC(findField(raw, FIELD_MAPPINGS.order_date)),
    currency_id: normalizeCurrency(findField(raw, FIELD_MAPPINGS.currency_id)),
    sale_amount: toCents(findField(raw, FIELD_MAPPINGS.sale_amount)),
    commission_amount: toCents(findField(raw, FIELD_MAPPINGS.commission_amount)),
    status: normalizeStatus(findField(raw, FIELD_MAPPINGS.status)),

    // Optional fields
    click_date: formatDateUTC(findField(raw, FIELD_MAPPINGS.click_date)) || '',
    validation_date: formatDateUTC(findField(raw, FIELD_MAPPINGS.validation_date)) || '',
    modified_date: formatDateUTC(findField(raw, FIELD_MAPPINGS.modified_date)) || '',
    sub_id_1: findField(raw, FIELD_MAPPINGS.sub_id_1) || '',
    sub_id_2: findField(raw, FIELD_MAPPINGS.sub_id_2) || '',
    sub_id_3: findField(raw, FIELD_MAPPINGS.sub_id_3) || '',
    sub_id_4: findField(raw, FIELD_MAPPINGS.sub_id_4) || '',
    sub_id_5: findField(raw, FIELD_MAPPINGS.sub_id_5) || '',
    sub_id_6: findField(raw, FIELD_MAPPINGS.sub_id_6) || '',
    decline_reason: findField(raw, FIELD_MAPPINGS.decline_reason) || '',
    paid_to_publisher: normalizePaidStatus(findField(raw, FIELD_MAPPINGS.paid_to_publisher)),
    clickout_url: findField(raw, FIELD_MAPPINGS.clickout_url) || '',
    product_title: extractProductTitle(raw),
    order_ref: findField(raw, FIELD_MAPPINGS.order_ref) || '',
  };

  return transformed;
}

/**
 * Finds a field value by trying multiple possible field names
 * @param {Object} record - The record to search
 * @param {Array<string>} possibleNames - Array of possible field names
 * @returns {*} The field value or undefined
 */
function findField(record, possibleNames) {
  for (const name of possibleNames) {
    if (record[name] !== undefined && record[name] !== null && record[name] !== '') {
      return record[name];
    }
  }
  return undefined;
}

/**
 * Extracts product title from BixGrow's nested commission_explanation structure
 * @param {Object} record - The raw record
 * @returns {string} Product title or empty string
 */
function extractProductTitle(record) {
  // Try direct product_title field first
  const direct = findField(record, FIELD_MAPPINGS.product_title);
  if (direct) return direct;

  // BixGrow stores product info in commission_explanation.line_items
  const explanation = record.commission_explanation;
  if (explanation?.line_items?.length > 0) {
    const titles = explanation.line_items
      .map(item => item.name || item.title || item.product_name)
      .filter(Boolean);
    return titles.join(', ');
  }

  return '';
}

/**
 * Generates a transaction ID if none exists
 * @param {Object} record - The record
 * @returns {string} Generated transaction ID
 */
function generateTransactionId(record) {
  // Create a deterministic ID from available fields
  const parts = [
    record.order_date || record.created_at || Date.now(),
    record.amount || record.sale_amount || 0,
    record.commission || record.commission_amount || 0,
  ];
  return `gen_${Buffer.from(parts.join('_')).toString('base64').slice(0, 16)}`;
}

/**
 * Formats a date to Y-m-d H:i:s UTC format
 * @param {string|number|Date} dateValue - Input date
 * @returns {string} Formatted date string or empty string
 */
export function formatDateUTC(dateValue) {
  if (!dateValue) return '';

  try {
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return '';

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (e) {
    console.warn('Failed to parse date:', dateValue);
    return '';
  }
}

/**
 * Converts a monetary value to cents
 * @param {string|number} value - Amount (could be dollars or already cents)
 * @returns {number} Amount in cents
 */
export function toCents(value) {
  if (value === undefined || value === null || value === '') return 0;

  // Parse the numeric value
  let numValue = typeof value === 'string'
    ? parseFloat(value.replace(/[^0-9.-]/g, ''))
    : Number(value);

  if (isNaN(numValue)) return 0;

  // Heuristic: if the value looks like dollars (has decimal places or is small),
  // convert to cents. If it's already a large integer, assume it's cents.
  // Values under 10000 with decimals are likely dollars
  if (numValue !== Math.floor(numValue) || (numValue > 0 && numValue < 10000)) {
    return Math.round(numValue * 100);
  }

  return Math.round(numValue);
}

/**
 * Normalizes currency code to 3-letter ISO 4217
 * @param {string} currency - Currency value
 * @returns {string} Normalized 3-letter currency code
 */
export function normalizeCurrency(currency) {
  if (!currency) return 'USD'; // Default to USD

  const normalized = String(currency).toUpperCase().trim();

  // Common currency mappings
  const currencyMap = {
    'DOLLAR': 'USD',
    'DOLLARS': 'USD',
    'US': 'USD',
    '$': 'USD',
    'EURO': 'EUR',
    'EUROS': 'EUR',
    '€': 'EUR',
    'POUND': 'GBP',
    'POUNDS': 'GBP',
    '£': 'GBP',
  };

  if (currencyMap[normalized]) {
    return currencyMap[normalized];
  }

  // If it's already a 3-letter code, return it
  if (/^[A-Z]{3}$/.test(normalized)) {
    return normalized;
  }

  return 'USD'; // Default fallback
}

/**
 * Normalizes status to one of: 'pending', 'approved', 'declined'
 * @param {string|number} status - Raw status value
 * @returns {string} Normalized status
 */
export function normalizeStatus(status) {
  if (status === undefined || status === null || status === '') return 'pending';

  // Handle numeric status codes (BixGrow uses these)
  if (typeof status === 'number' || /^\d+$/.test(String(status))) {
    const numStatus = Number(status);
    if (NUMERIC_STATUS_MAP[numStatus]) {
      return NUMERIC_STATUS_MAP[numStatus];
    }
  }

  const normalized = String(status).toLowerCase().trim();

  for (const [targetStatus, variants] of Object.entries(STATUS_MAPPINGS)) {
    if (variants.includes(normalized)) {
      return targetStatus;
    }
  }

  // Default to pending for unknown statuses
  console.warn(`Unknown status "${status}", defaulting to "pending"`);
  return 'pending';
}

/**
 * Normalizes paid to publisher status to '1' or '0'
 * @param {*} value - Raw paid status
 * @returns {string} '1' or '0', or empty string if not set
 */
export function normalizePaidStatus(value) {
  if (value === undefined || value === null || value === '') return '';

  const truthyValues = [true, 1, '1', 'yes', 'true', 'paid'];
  return truthyValues.includes(value) || truthyValues.includes(String(value).toLowerCase())
    ? '1'
    : '0';
}

/**
 * Converts transformed records to array format for Google Sheets
 * @param {Array} records - Transformed records
 * @returns {Array<Array>} 2D array for Sheets API
 */
export function toSheetRows(records) {
  const headers = [
    'transaction_id',
    'advertiser_id',
    'advertiser_name',
    'order_date',
    'currency_id',
    'sale_amount',
    'commission_amount',
    'status',
    'click_date',
    'validation_date',
    'modified_date',
    'sub_id_1',
    'sub_id_2',
    'sub_id_3',
    'sub_id_4',
    'sub_id_5',
    'sub_id_6',
    'decline_reason',
    'paid_to_publisher',
    'clickout_url',
    'product_title',
    'order_ref',
  ];

  const rows = records.map(record =>
    headers.map(header => record[header] ?? '')
  );

  return [headers, ...rows];
}

/**
 * Gets just the header row
 * @returns {Array<string>} Header names
 */
export function getHeaders() {
  return [
    'transaction_id',
    'advertiser_id',
    'advertiser_name',
    'order_date',
    'currency_id',
    'sale_amount',
    'commission_amount',
    'status',
    'click_date',
    'validation_date',
    'modified_date',
    'sub_id_1',
    'sub_id_2',
    'sub_id_3',
    'sub_id_4',
    'sub_id_5',
    'sub_id_6',
    'decline_reason',
    'paid_to_publisher',
    'clickout_url',
    'product_title',
    'order_ref',
  ];
}

