/**
 * Generic transformer for affiliate commission data.
 * Each scraper provides its own field mappings via config.
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

// Status value mappings to normalize different representations
const STATUS_MAPPINGS = {
  pending: ['pending', 'new', 'open', 'waiting', 'unconfirmed', 'unpaid'],
  approved: ['approved', 'confirmed', 'validated', 'active', 'complete', 'completed', 'paid', 'due', 'ready'],
  declined: ['declined', 'rejected', 'cancelled', 'canceled', 'void', 'voided', 'refunded'],
};

/**
 * Creates a transformer with platform-specific configuration
 * @param {Object} config - Transformer configuration
 * @param {Object} config.fieldMappings - Maps target fields to arrays of possible source field names
 * @param {Object} [config.statusMappings] - Maps numeric status codes to status strings
 * @param {string} config.advertiserId - Advertiser ID
 * @param {string} config.advertiserName - Advertiser display name
 * @param {Function} [config.extractProductTitle] - Custom product title extractor
 * @returns {Object} Transformer instance
 */
export function createTransformer(config) {
  const {
    fieldMappings,
    statusMappings = {},
    advertiserId,
    advertiserName,
    extractProductTitle,
  } = config;

  /**
   * Finds a field value by trying multiple possible field names
   */
  function findField(record, possibleNames) {
    if (!possibleNames) return undefined;
    for (const name of possibleNames) {
      if (record[name] !== undefined && record[name] !== null && record[name] !== '') {
        return record[name];
      }
    }
    return undefined;
  }

  /**
   * Normalizes status to one of: 'pending', 'approved', 'declined'
   */
  function normalizeStatus(status) {
    if (status === undefined || status === null || status === '') return 'pending';

    // Handle numeric status codes
    if (typeof status === 'number' || /^\d+$/.test(String(status))) {
      const numStatus = Number(status);
      if (statusMappings[numStatus]) {
        return statusMappings[numStatus];
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
   * Transforms a single raw record to the target schema
   */
  function transformRecord(raw) {
    const transformed = {
      // Required fields
      transaction_id: findField(raw, fieldMappings.transaction_id) || generateTransactionId(raw),
      advertiser_id: advertiserId,
      advertiser_name: advertiserName,
      order_date: formatDateUTC(findField(raw, fieldMappings.order_date)),
      currency_id: normalizeCurrency(findField(raw, fieldMappings.currency_id)),
      sale_amount: toCents(findField(raw, fieldMappings.sale_amount)),
      commission_amount: toCents(findField(raw, fieldMappings.commission_amount)),
      status: normalizeStatus(findField(raw, fieldMappings.status)),

      // Optional fields
      click_date: formatDateUTC(findField(raw, fieldMappings.click_date)) || '',
      validation_date: formatDateUTC(findField(raw, fieldMappings.validation_date)) || '',
      modified_date: formatDateUTC(findField(raw, fieldMappings.modified_date)) || '',
      sub_id_1: String(findField(raw, fieldMappings.sub_id_1) || ''),
      sub_id_2: String(findField(raw, fieldMappings.sub_id_2) || ''),
      sub_id_3: String(findField(raw, fieldMappings.sub_id_3) || ''),
      sub_id_4: String(findField(raw, fieldMappings.sub_id_4) || ''),
      sub_id_5: String(findField(raw, fieldMappings.sub_id_5) || ''),
      sub_id_6: String(findField(raw, fieldMappings.sub_id_6) || ''),
      decline_reason: findField(raw, fieldMappings.decline_reason) || '',
      paid_to_publisher: normalizePaidStatus(findField(raw, fieldMappings.paid_to_publisher)),
      clickout_url: findField(raw, fieldMappings.clickout_url) || '',
      product_title: extractProductTitle ? extractProductTitle(raw) : (findField(raw, fieldMappings.product_title) || ''),
      order_ref: String(findField(raw, fieldMappings.order_ref) || ''),
    };

    return transformed;
  }

  /**
   * Transforms an array of raw records to the target schema
   */
  function transformRecords(rawRecords) {
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

  return {
    transformRecord,
    transformRecords,
    findField,
    normalizeStatus,
  };
}

/**
 * Generates a transaction ID if none exists
 */
function generateTransactionId(record) {
  const parts = [
    record.order_date || record.created_at || Date.now(),
    record.amount || record.sale_amount || 0,
    record.commission || record.commission_amount || 0,
  ];
  return `gen_${Buffer.from(parts.join('_')).toString('base64').slice(0, 16)}`;
}

/**
 * Formats a date to Y-m-d H:i:s UTC format
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
 */
export function toCents(value) {
  if (value === undefined || value === null || value === '') return 0;

  let numValue = typeof value === 'string'
    ? parseFloat(value.replace(/[^0-9.-]/g, ''))
    : Number(value);

  if (isNaN(numValue)) return 0;

  // Heuristic: if the value looks like dollars (has decimal places or is small),
  // convert to cents. If it's already a large integer, assume it's cents.
  if (numValue !== Math.floor(numValue) || (numValue > 0 && numValue < 10000)) {
    return Math.round(numValue * 100);
  }

  return Math.round(numValue);
}

/**
 * Normalizes currency code to 3-letter ISO 4217
 */
export function normalizeCurrency(currency) {
  if (!currency) return 'USD';

  const normalized = String(currency).toUpperCase().trim();

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

  if (/^[A-Z]{3}$/.test(normalized)) {
    return normalized;
  }

  return 'USD';
}

/**
 * Normalizes paid to publisher status to '1' or '0'
 */
export function normalizePaidStatus(value) {
  if (value === undefined || value === null || value === '') return '';

  const truthyValues = [true, 1, '1', 'yes', 'true', 'paid'];
  return truthyValues.includes(value) || truthyValues.includes(String(value).toLowerCase())
    ? '1'
    : '0';
}

/**
 * Gets the standard headers for the output schema
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

/**
 * Converts transformed records to array format for Google Sheets
 */
export function toSheetRows(records) {
  const headers = getHeaders();
  const rows = records.map(record =>
    headers.map(header => record[header] ?? '')
  );
  return [headers, ...rows];
}

