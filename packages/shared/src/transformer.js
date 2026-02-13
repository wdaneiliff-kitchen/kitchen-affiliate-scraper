import { createHash } from 'node:crypto';

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
  pending: ['pending', 'new', 'open', 'waiting', 'unconfirmed', 'created'],
  approved: ['approved', 'confirmed', 'validated', 'active', 'complete', 'completed', 'paid', 'due', 'ready', 'ready_for_payout', 'unpaid'],
  declined: ['declined', 'rejected', 'cancelled', 'canceled', 'void', 'voided', 'refunded', 'partially refunded'],
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
    // Resolve fields needed for both output and deterministic ID generation
    const orderDate = formatDateUTC(findField(raw, fieldMappings.order_date));
    const saleAmount = toCents(findField(raw, fieldMappings.sale_amount));
    const commissionAmount = toCents(findField(raw, fieldMappings.commission_amount));
    const subId2 = String(findField(raw, fieldMappings.sub_id_2) || '');

    // Use natural transaction ID if available, otherwise generate a deterministic one
    const naturalId = findField(raw, fieldMappings.transaction_id);

    const transformed = {
      // Required fields
      transaction_id: naturalId || generateTransactionId({
        advertiserId,
        orderDate,
        saleAmount,
        commissionAmount,
        subId2,
      }),
      advertiser_id: advertiserId,
      advertiser_name: advertiserName,
      order_date: orderDate,
      currency_id: normalizeCurrency(findField(raw, fieldMappings.currency_id)),
      sale_amount: saleAmount,
      commission_amount: commissionAmount,
      status: normalizeStatus(findField(raw, fieldMappings.status)),

      // Optional fields
      click_date: formatDateUTC(findField(raw, fieldMappings.click_date)) || '',
      validation_date: formatDateUTC(findField(raw, fieldMappings.validation_date)) || '',
      modified_date: formatDateUTC(findField(raw, fieldMappings.modified_date)) || '',
      sub_id_1: String(findField(raw, fieldMappings.sub_id_1) || ''),
      sub_id_2: subId2,
      sub_id_3: String(findField(raw, fieldMappings.sub_id_3) || ''),
      sub_id_4: String(findField(raw, fieldMappings.sub_id_4) || ''),
      sub_id_5: String(findField(raw, fieldMappings.sub_id_5) || ''),
      sub_id_6: String(findField(raw, fieldMappings.sub_id_6) || ''),
      decline_reason: findField(raw, fieldMappings.decline_reason) || '',
      paid_to_publisher: normalizePaidStatus(findField(raw, fieldMappings.paid_to_publisher)),
      clickout_url: sanitizeUrl(findField(raw, fieldMappings.clickout_url)),
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
 * Generates a deterministic transaction ID from already-resolved field values.
 * Uses a SHA-256 content hash so the same order always produces the same ID
 * regardless of when or where the scraper runs.
 *
 * Includes advertiserId, orderDate, amounts, and sub_id_2 (typically the
 * product/landing page URL) to differentiate orders that share the same
 * date and amounts.
 *
 * @param {Object} fields - Already-resolved field values
 * @returns {string} Deterministic transaction ID like "gen_AbCdEf1234567890"
 */
function generateTransactionId(fields) {
  const parts = [
    fields.advertiserId || '',
    fields.orderDate || '',
    fields.saleAmount || 0,
    fields.commissionAmount || 0,
    fields.subId2 || '',
  ];
  const content = parts.join('|');
  const hash = createHash('sha256').update(content).digest('base64url').slice(0, 16);
  return `gen_${hash}`;
}

/**
 * Formats a date to Y-m-d H:i:s UTC format.
 * Handles relative time prefixes from scraped pages (e.g., "14 hours agoFeb 7, 2026 8:20 PM").
 *
 * All ambiguous date strings (without explicit timezone info) are treated as
 * UTC to ensure consistent output regardless of where the code runs (e.g.,
 * local machine in PST vs GitHub Actions in UTC).
 */
export function formatDateUTC(dateValue) {
  if (!dateValue) return '';

  try {
    const str = String(dateValue).trim();

    // Try direct parse (forced to UTC for ambiguous strings)
    let date = parseAsUTC(str);
    if (date) {
      return formatDateComponents(date);
    }

    // Handle relative time prefix (e.g., "14 hours agoFeb 7, 2026 8:20 PM")
    const agoIndex = str.lastIndexOf('ago');
    if (agoIndex !== -1) {
      const afterAgo = str.slice(agoIndex + 3).trim();
      date = parseAsUTC(afterAgo);
      if (date) {
        return formatDateComponents(date);
      }
    }

    // Try extracting a month-based date pattern (e.g., "Feb 7, 2026 8:20 PM")
    const monthPattern = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}[\s\d:APMapm]*/i;
    const monthMatch = str.match(monthPattern);
    if (monthMatch) {
      date = parseAsUTC(monthMatch[0].trim());
      if (date) {
        return formatDateComponents(date);
      }
    }

    return '';
  } catch (e) {
    console.warn('Failed to parse date:', dateValue);
    return '';
  }
}

/**
 * Parses a date string, treating ambiguous strings (no timezone info) as UTC.
 * This ensures consistent results regardless of the system timezone.
 *
 * Behaviour by format:
 * - "2025-12-23"                → UTC by spec (ISO date-only)
 * - "2025-12-23T19:12:00"      → append "Z" to force UTC
 * - "2025-12-23T19:12:00Z"     → already UTC, parse as-is
 * - "Dec 23, 2025 7:12 PM"     → append " UTC" to force UTC
 * - "Dec 23, 2025 7:12 PM GMT" → already has timezone, parse as-is
 *
 * @param {string} str - Date string to parse
 * @returns {Date|null} Parsed Date object or null if unparseable
 */
function parseAsUTC(str) {
  if (!str) return null;

  // Already has timezone info — parse as-is
  if (hasTimezoneInfo(str)) {
    const date = new Date(str);
    return isNaN(date.getTime()) ? null : date;
  }

  // ISO format with time but no timezone (e.g., "2025-12-23T19:12:00") — append Z
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) {
    const date = new Date(str + 'Z');
    if (!isNaN(date.getTime())) return date;
  }

  // ISO date-only (e.g., "2025-12-23") — already treated as UTC by spec
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const date = new Date(str);
    if (!isNaN(date.getTime())) return date;
  }

  // Non-ISO format (e.g., "Feb 7, 2026 8:20 PM") — append " UTC" to force UTC
  const dateWithUTC = new Date(str + ' UTC');
  if (!isNaN(dateWithUTC.getTime())) return dateWithUTC;

  // Final fallback: try original string
  const date = new Date(str);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Returns true if the date string contains explicit timezone information.
 */
function hasTimezoneInfo(str) {
  // Z suffix, UTC/GMT, or ±HH:MM / ±HHMM offset at end of string
  return /(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})\s*$/i.test(str);
}

/**
 * Formats a Date object to Y-m-d H:i:s UTC string
 */
function formatDateComponents(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
 * Validates and sanitizes a URL value.
 * Returns empty string for values that aren't valid URLs (e.g., "s", random strings).
 */
function sanitizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    // Not a valid URL
  }

  return '';
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
 * Returns true if a transformed record is a valid commission (has order date and non-zero money).
 * Used to avoid uploading scraped noise (e.g. settings tables) or placeholder rows.
 *
 * @param {Object} record - Transformed record with order_date, sale_amount, commission_amount
 * @returns {boolean}
 */
export function isValidCommissionRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const orderDate = record.order_date;
  const hasDate = typeof orderDate === 'string' && orderDate.trim().length > 0;
  const sale = Number(record.sale_amount);
  const commission = Number(record.commission_amount);
  const hasMoney = (typeof sale === 'number' && !isNaN(sale) && sale > 0) ||
    (typeof commission === 'number' && !isNaN(commission) && commission > 0);
  return hasDate && hasMoney;
}

/**
 * Filters an array of transformed records to only valid commission records.
 *
 * @param {Array<Object>} records - Transformed records
 * @returns {Array<Object>} Records that pass isValidCommissionRecord
 */
export function filterValidCommissionRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.filter(isValidCommissionRecord);
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

