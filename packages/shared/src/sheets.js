import { google } from 'googleapis';
import { readFile } from 'fs/promises';
import { getHeaders, filterValidCommissionRecords } from './transformer.js';

/**
 * Google Sheets upload module using service account authentication.
 * Supports appending data or updating existing rows based on transaction_id.
 */

/**
 * Creates an authenticated Google Sheets API client
 * @param {string} credentialsPath - Path to service account JSON key file
 * @returns {Promise<Object>} Authenticated sheets API client
 */
async function getAuthenticatedClient(credentialsPath) {
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf-8'));

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * Uploads commission data to Google Sheets
 *
 * @param {Object} options - Upload options
 * @param {string} options.spreadsheetId - Google Sheet ID
 * @param {string} options.credentialsPath - Path to service account JSON
 * @param {Array} options.records - Transformed commission records
 * @param {string} [options.sheetName='Commissions'] - Sheet/tab name
 * @param {boolean} [options.clearFirst=false] - Clear existing data before uploading
 * @param {boolean} [options.dedupeByTransactionId=true] - Skip records with existing transaction_id
 * @returns {Promise<Object>} Upload result with counts
 */
export async function uploadToSheets({
  spreadsheetId,
  credentialsPath,
  records,
  sheetName = 'Commissions',
  clearFirst = false,
  dedupeByTransactionId = true,
}) {
  // Only upload valid commission records (order_date + non-zero sale or commission)
  const validRecords = filterValidCommissionRecords(records);
  const invalidCount = records.length - validRecords.length;
  if (invalidCount > 0) {
    console.log(`⚠️ Skipping ${invalidCount} invalid records (missing order_date or zero amounts)`);
  }
  console.log(`📤 Uploading ${validRecords.length} records to Google Sheets...`);

  const sheets = await getAuthenticatedClient(credentialsPath);
  const range = `${sheetName}!A:V`; // Columns A through V (22 columns)

  try {
    // Check if sheet exists and has headers
    const existingData = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const existingRows = existingData.data.values || [];
    const hasHeaders = existingRows.length > 0;

    // If clearing, remove all data first
    if (clearFirst && existingRows.length > 0) {
      console.log('🗑️ Clearing existing data...');
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range,
      });
    }

    // Get existing transaction IDs for deduplication
    let existingTransactionIds = new Set();
    if (dedupeByTransactionId && !clearFirst && existingRows.length > 1) {
      // Find transaction_id column index
      const headers = existingRows[0];
      const txIdIndex = headers.findIndex(h =>
        h.toLowerCase().replace(/\s+/g, '_') === 'transaction_id'
      );

      if (txIdIndex !== -1) {
        for (let i = 1; i < existingRows.length; i++) {
          const txId = existingRows[i][txIdIndex];
          if (txId) existingTransactionIds.add(String(txId));
        }
        console.log(`📋 Found ${existingTransactionIds.size} existing transaction IDs`);
      }
    }

    // Filter out duplicates
    let recordsToUpload = validRecords;
    let skippedCount = 0;

    if (dedupeByTransactionId && existingTransactionIds.size > 0) {
      recordsToUpload = validRecords.filter(record => {
        if (existingTransactionIds.has(String(record.transaction_id))) {
          skippedCount++;
          return false;
        }
        return true;
      });

      if (skippedCount > 0) {
        console.log(`⏭️ Skipping ${skippedCount} duplicate records`);
      }
    }

    if (recordsToUpload.length === 0) {
      console.log('ℹ️ No new records to upload');
      return {
        success: true,
        uploaded: 0,
        skipped: skippedCount,
        total: records.length,
        invalid: invalidCount,
      };
    }

    // Prepare data for upload
    const headers = getHeaders();
    const dataRows = recordsToUpload.map(record =>
      headers.map(header => String(record[header] ?? ''))
    );

    // If no existing headers or cleared, add headers first
    const valuesToUpload = (!hasHeaders || clearFirst)
      ? [headers, ...dataRows]
      : dataRows;

    // Determine where to append
    const appendRange = (!hasHeaders || clearFirst)
      ? `${sheetName}!A1`
      : `${sheetName}!A${existingRows.length + 1}`;

    // Upload data
    const result = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: appendRange,
      valueInputOption: 'RAW',
      requestBody: {
        values: valuesToUpload,
      },
    });

    console.log(`✅ Successfully uploaded ${recordsToUpload.length} records`);

    return {
      success: true,
      uploaded: recordsToUpload.length,
      skipped: skippedCount,
      total: records.length,
      invalid: invalidCount,
      updatedRange: result.data.updatedRange,
    };

  } catch (error) {
    console.error('❌ Upload failed:', error.message);

    if (error.code === 404) {
      throw new Error(`Spreadsheet not found. Make sure the sheet ID is correct and the service account has access.`);
    }

    if (error.code === 403) {
      throw new Error(`Permission denied. Make sure the spreadsheet is shared with the service account email.`);
    }

    throw error;
  }
}

/**
 * Creates a new spreadsheet with the correct headers
 * @param {Object} options - Options
 * @param {string} options.credentialsPath - Path to service account JSON
 * @param {string} options.title - Spreadsheet title
 * @returns {Promise<string>} New spreadsheet ID
 */
export async function createSpreadsheet({ credentialsPath, title }) {
  console.log(`📝 Creating new spreadsheet: ${title}`);

  const sheets = await getAuthenticatedClient(credentialsPath);

  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [{
        properties: { title: 'Commissions' },
      }],
    },
  });

  const spreadsheetId = response.data.spreadsheetId;
  console.log(`✅ Created spreadsheet: ${spreadsheetId}`);

  // Add headers
  const headers = getHeaders();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Commissions!A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [headers],
    },
  });

  console.log(`📋 Added headers to sheet`);
  console.log(`🔗 Sheet URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

  return spreadsheetId;
}

/**
 * Validates that the service account has access to the spreadsheet
 * @param {Object} options - Options
 * @param {string} options.credentialsPath - Path to service account JSON
 * @param {string} options.spreadsheetId - Spreadsheet ID to check
 * @returns {Promise<boolean>} True if access is valid
 */
export async function validateAccess({ credentialsPath, spreadsheetId }) {
  try {
    const sheets = await getAuthenticatedClient(credentialsPath);

    await sheets.spreadsheets.get({
      spreadsheetId,
    });

    console.log('✅ Service account has access to spreadsheet');
    return true;

  } catch (error) {
    if (error.code === 404) {
      console.error('❌ Spreadsheet not found');
    } else if (error.code === 403) {
      console.error('❌ Service account does not have access to this spreadsheet');
      console.error('💡 Share the spreadsheet with your service account email');
    } else {
      console.error('❌ Access validation failed:', error.message);
    }
    return false;
  }
}

/**
 * Gets the service account email from credentials
 * @param {string} credentialsPath - Path to service account JSON
 * @returns {Promise<string>} Service account email
 */
export async function getServiceAccountEmail(credentialsPath) {
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf-8'));
  return credentials.client_email;
}

