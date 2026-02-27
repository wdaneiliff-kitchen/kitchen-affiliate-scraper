/**
 * GoAffPro (Forwrd) scraper configuration.
 *
 * Field mappings are based on common GoAffPro API response patterns.
 * They will be refined once real sales data appears in the Details table.
 */

export const ADVERTISER_ID = process.env.ADVERTISER_ID || 'goaffpro-forwrd';
export const ADVERTISER_NAME = process.env.ADVERTISER_NAME || 'GoAffPro (Forwrd)';

/** Normalise GoAffPro status strings to the shared target schema values */
export const STATUS_MAPPINGS = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'declined',
  declined: 'declined',
  paid: 'approved',
  unpaid: 'pending',
  flagged: 'pending',
  // Numeric codes sometimes returned by GoAffPro API
  0: 'pending',
  1: 'approved',
  2: 'declined',
};

/**
 * Maps GoAffPro API / DOM field names to the shared target schema.
 * Each key is a target schema field; each value is an ordered list of
 * candidate source field names to try (first match wins).
 */
export const FIELD_MAPPINGS = {
  transaction_id: ['id', 'order_id', 'orderId', 'commission_id', 'commissionId', 'transaction_id', 'transactionId', 'ref'],

  order_date: ['created_at', 'createdAt', 'date', 'order_date', 'orderDate', 'commission_date', 'commissionDate'],
  click_date: ['click_date', 'clickDate', 'clicked_at', 'clickedAt'],
  validation_date: ['approved_at', 'approvedAt', 'validated_at', 'validatedAt', 'paid_at', 'paidAt'],
  modified_date: ['updated_at', 'updatedAt', 'modified_at', 'modifiedAt'],

  currency_id: ['currency', 'currency_code', 'currencyCode', 'currency_id'],

  sale_amount: ['sale_amount', 'saleAmount', 'order_total', 'orderTotal', 'total', 'revenue', 'subtotal'],
  commission_amount: ['commission', 'commission_amount', 'commissionAmount', 'amount', 'earnings', 'payout'],

  status: ['status', 'state', 'commission_status', 'commissionStatus'],

  sub_id_1: ['sub_id', 'subId', 'sub_id_1', 'affiliate_id', 'affiliateId', 'coupon', 'coupon_code'],
  sub_id_2: ['sub_id_2', 'subId2', 'campaign_id', 'campaignId'],
  sub_id_3: ['sub_id_3', 'subId3', 'link_id', 'linkId'],
  sub_id_4: ['sub_id_4', 'subId4'],
  sub_id_5: ['sub_id_5', 'subId5'],
  sub_id_6: ['sub_id_6', 'subId6'],

  decline_reason: ['decline_reason', 'declineReason', 'rejection_reason', 'reason', 'notes'],
  paid_to_publisher: ['paid', 'is_paid', 'isPaid', 'paid_out', 'paidOut'],
  clickout_url: ['url', 'link', 'destination_url', 'landing_url', 'referrer'],
  product_title: ['product', 'product_title', 'productTitle', 'product_name', 'productName', 'item', 'item_name'],
  order_ref: ['order_id', 'orderId', 'order_ref', 'orderRef', 'reference', 'external_id'],
};

/**
 * Attempts to extract a product title from a raw GoAffPro record.
 * @param {Object} record - Raw record from API or DOM
 * @returns {string}
 */
export function extractProductTitle(record) {
  const directFields = ['product', 'product_title', 'productTitle', 'product_name', 'productName', 'item', 'item_name'];
  for (const field of directFields) {
    if (record[field]) return String(record[field]);
  }

  if (record.line_items?.length > 0) {
    return record.line_items
      .map(item => item.name || item.title || item.product_name)
      .filter(Boolean)
      .join(', ');
  }

  if (record.items?.length > 0) {
    return record.items
      .map(item => item.name || item.title || item.product_name)
      .filter(Boolean)
      .join(', ');
  }

  return '';
}
