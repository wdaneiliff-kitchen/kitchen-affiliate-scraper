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
// "Ready" = ready for payout (approved)
// "Paid" = already paid out (approved)
// "Pending" = awaiting approval
export const STATUS_MAPPINGS = {
  'ready': 'approved',
  'paid': 'approved',
  'pending': 'pending',
  'cancelled': 'declined',
  'refunded': 'declined',
};

// Field name mappings from SocialSnowball to target schema
// These are initial guesses based on common affiliate platform patterns
// They will be updated after we see the actual API response structure
export const FIELD_MAPPINGS = {
  // Transaction ID variations
  transaction_id: ['id', 'payout_id', 'payoutId', 'transaction_id', 'transactionId', 'commission_id', 'commissionId'],

  // Date fields
  order_date: ['created_at', 'createdAt', 'date', 'order_date', 'orderDate', 'commission_date', 'commissionDate'],
  click_date: ['click_date', 'clickDate', 'clicked_at', 'clickedAt'],
  validation_date: ['approved_at', 'approvedAt', 'validated_at', 'validatedAt', 'paid_at', 'paidAt'],
  modified_date: ['updated_at', 'updatedAt', 'modified_at', 'modifiedAt'],

  // Currency
  currency_id: ['currency', 'currency_code', 'currencyCode', 'currency_id'],

  // Amounts - SocialSnowball likely uses 'amount', 'commission', 'payout' etc.
  sale_amount: ['sale_amount', 'saleAmount', 'order_total', 'orderTotal', 'total', 'revenue', 'order_amount'],
  commission_amount: ['amount', 'commission', 'commission_amount', 'commissionAmount', 'payout', 'payout_amount', 'earnings'],

  // Status
  status: ['status', 'state', 'payout_status', 'payoutStatus'],

  // Sub IDs / tracking
  sub_id_1: ['sub_id', 'subId', 'sub_id_1', 'affiliate_id', 'affiliateId'],
  sub_id_2: ['sub_id_2', 'subId2', 'campaign_id', 'campaignId'],
  sub_id_3: ['sub_id_3', 'subId3', 'link_id', 'linkId'],
  sub_id_4: ['sub_id_4', 'subId4'],
  sub_id_5: ['sub_id_5', 'subId5'],
  sub_id_6: ['sub_id_6', 'subId6'],

  // Other optional fields
  decline_reason: ['decline_reason', 'declineReason', 'rejection_reason', 'reason', 'notes'],
  paid_to_publisher: ['paid', 'is_paid', 'isPaid', 'paid_out', 'paidOut'],
  clickout_url: ['url', 'link', 'destination_url', 'landing_url', 'source_url'],
  product_title: ['product', 'product_title', 'productTitle', 'product_name', 'productName', 'item'],
  order_ref: ['order_id', 'orderId', 'order_ref', 'orderRef', 'reference', 'external_id', 'shop_order_id'],
};

/**
 * Extract product title from SocialSnowball record
 * Will be refined after seeing actual data structure
 */
export function extractProductTitle(record) {
  // Try direct fields first
  const directFields = ['product', 'product_title', 'productTitle', 'product_name', 'productName', 'item', 'item_name'];
  for (const field of directFields) {
    if (record[field]) return String(record[field]);
  }

  // Try nested structures (common in e-commerce platforms)
  if (record.line_items?.length > 0) {
    const titles = record.line_items
      .map(item => item.name || item.title || item.product_name)
      .filter(Boolean);
    return titles.join(', ');
  }

  if (record.order?.line_items?.length > 0) {
    const titles = record.order.line_items
      .map(item => item.name || item.title)
      .filter(Boolean);
    return titles.join(', ');
  }

  return '';
}

