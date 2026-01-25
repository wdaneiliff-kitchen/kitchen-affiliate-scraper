/**
 * BixGrow-specific configuration for the transformer
 */

// Advertiser config - set via environment variables or use defaults
export const ADVERTISER_ID = process.env.ADVERTISER_ID || 'joola';
export const ADVERTISER_NAME = process.env.ADVERTISER_NAME || 'Joola';

// BixGrow uses numeric status codes
export const STATUS_MAPPINGS = {
  1: 'pending',    // Pending approval
  2: 'declined',   // Rejected
  3: 'declined',   // Cancelled
  6: 'approved',   // Approved/Paid
};

// Common field name mappings from BixGrow to target schema
export const FIELD_MAPPINGS = {
  // Transaction ID variations
  transaction_id: ['transaction_id', 'transactionId', 'id', 'conversion_id', 'conversionId'],

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

/**
 * Extracts product title from BixGrow's nested commission_explanation structure
 */
export function extractProductTitle(record) {
  // Try direct product_title field first
  const directFields = ['product_title', 'productTitle', 'product_name', 'productName', 'item_name', 'itemName', 'product'];
  for (const field of directFields) {
    if (record[field]) return record[field];
  }

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

