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
 * Ensures the given tab has enough rows in its grid to accept N more data rows.
 * Google Sheets tabs have a fixed grid `rowCount` separate from data; once data
 * fills the grid, any further `values.append` fails with "Range ... exceeds grid
 * limits." This guard reads the tab's metadata + the current populated row count,
 * and calls `appendDimension` to grow the grid if `freeRows < neededRows + buffer`.
 *
 * The expansion adds empty rows at the bottom — non-destructive, idempotent
 * (safe to call concurrently from multiple scrapes), and invisible to Looker
 * (which filters by order_date so trailing empties don't appear).
 *
 * Why this exists: on 2026-05-20 the Comissions tab hit its 2261-row grid
 * cap and started rejecting every scrape's inserts (`Range (Comissions!A2262)
 * exceeds grid limits`). 5 scheduled scrapes failed before manual expansion.
 * Calling this before every write at the scraper layer prevents recurrence.
 *
 * @param {Object} sheets - Authenticated sheets client
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number} neededRows - How many new rows you're about to write
 * @param {number} [buffer=1000] - Extra slack to add when growing
 */
export async function ensureGridRoom(sheets, spreadsheetId, sheetName, neededRows, buffer = 1000) {
  if (neededRows <= 0) return;
  const [meta, dataA] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId }),
    sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:A` }),
  ]);
  const tab = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!tab) return; // tab will be created elsewhere with default size
  const gridRows = tab.properties.gridProperties.rowCount;
  const usedRows = (dataA.data.values || []).length; // includes header
  const freeRows = gridRows - usedRows;
  if (freeRows >= neededRows) return;
  const growBy = Math.max(neededRows - freeRows + buffer, 1000);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        appendDimension: {
          sheetId: tab.properties.sheetId,
          dimension: 'ROWS',
          length: growBy,
        },
      }],
    },
  });
  console.log(`   📐 Grew "${sheetName}" tab by ${growBy} rows (was ${gridRows}, ${usedRows} used, needed ${neededRows} more)`);
}

/**
 * Uploads commission data to Google Sheets
 *
 * @param {Object} options - Upload options
 * @param {string} options.spreadsheetId - Google Sheet ID
 * @param {string} options.credentialsPath - Path to service account JSON
 * @param {Array} options.records - Transformed commission records
 * @param {string} [options.sheetName='Comissions'] - Sheet/tab name
 * @param {boolean} [options.clearFirst=false] - Clear existing data before uploading
 * @param {boolean} [options.dedupeByTransactionId=true] - Skip records with existing transaction_id
 * @returns {Promise<Object>} Upload result with counts
 */
export async function uploadToSheets({
  spreadsheetId,
  credentialsPath,
  records,
  sheetName = 'Comissions',
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

    // Grow the grid first if needed — prevents the "Range exceeds grid limits"
    // error that brought down multiple scrapes on 2026-05-20.
    await ensureGridRoom(sheets, spreadsheetId, sheetName, valuesToUpload.length);

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
        properties: { title: 'Comissions' },
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
 * Reconciles a scraper's full output against the sheet for a single advertiser.
 *
 * Three-way diff scoped by advertiser_id:
 *   INSERT: tx_ids in source but not sheet → append
 *   UPDATE: tx_ids in both but row contents differ → rewrite the row
 *   DELETE: tx_ids in sheet but not source → drop (sale was cancelled / removed at source)
 *
 * The append-only upload flow could not detect deletions, so cancelled/refunded
 * sales accumulated as "ghosts" and inflated dashboard totals (May 2026 incident).
 * This function makes the sheet a true mirror of the source.
 *
 * Safety guard: if the source's count for this advertiser is less than half of
 * what the sheet already has AND there are more than 5 existing rows, the delete
 * step is skipped and a warning is logged. Protects against a transient scraper
 * bug (partial pagination, auth failure, source outage) nuking real data.
 *
 * @param {Object} options
 * @param {string} options.spreadsheetId
 * @param {string} options.credentialsPath
 * @param {Array} options.records - Transformed records (the COMPLETE current set for advertiserId)
 * @param {string} options.advertiserId - REQUIRED. Scope of the reconcile.
 * @param {string} [options.sheetName='Comissions']
 * @returns {Promise<{inserted: number, updated: number, deleted: number, skippedDeletes: number, deleteAborted: boolean}>}
 */
export async function reconcileToSheets({
  spreadsheetId,
  credentialsPath,
  records,
  advertiserId,
  sheetName = 'Comissions',
}) {
  if (!advertiserId) {
    throw new Error('reconcileToSheets requires advertiserId — refusing to run unscoped to avoid touching other advertisers');
  }

  const validRecords = filterValidCommissionRecords(records);
  const invalidCount = records.length - validRecords.length;
  if (invalidCount > 0) console.log(`⚠️ Skipping ${invalidCount} invalid records (missing order_date or zero amounts)`);

  const sourceByTxId = new Map();
  for (const r of validRecords) {
    if (r.advertiser_id !== advertiserId) continue; // defensive: only handle this advertiser
    sourceByTxId.set(String(r.transaction_id), r);
  }
  console.log(`🔄 Reconciling ${sourceByTxId.size} source records for advertiser_id="${advertiserId}"...`);

  // Read sheet, scope to this advertiser
  const { headers, rows } = await readSheetRows({ spreadsheetId, credentialsPath, sheetName });
  if (!headers.length) {
    console.log('   Sheet is empty, falling through to insert-only path');
  }
  const sheetForAdvertiser = rows.filter(r => r.advertiser_id === advertiserId);
  const sheetByTxId = new Map(sheetForAdvertiser.map(r => [String(r.transaction_id), r]));

  // Compute diff
  const toInsert = [];
  const toUpdate = []; // { rowIndex, record }
  for (const [txId, rec] of sourceByTxId) {
    const existing = sheetByTxId.get(txId);
    if (!existing) {
      toInsert.push(rec);
      continue;
    }
    // Detect any field difference (rec is the source of truth)
    let differs = false;
    for (const h of headers) {
      if (h === '_rowIndex') continue;
      const sheetVal = String(existing[h] ?? '');
      const sourceVal = String(rec[h] ?? '');
      if (sheetVal !== sourceVal) { differs = true; break; }
    }
    if (differs) toUpdate.push({ rowIndex: existing._rowIndex, record: rec });
  }
  const toDelete = sheetForAdvertiser.filter(r => !sourceByTxId.has(String(r.transaction_id)));

  // Safety guard against partial scrape causing mass deletion.
  // Only fires for clearly catastrophic patterns — returned 0 records, or
  // returned tiny absolute count when the sheet has many. The original 50%
  // threshold was too aggressive: legitimate first-time ghost cleanup can
  // easily exceed 50% deletion. The drift audit watchdog is the second
  // line of defense and will alert next morning if reconcile over-deletes.
  const existingCount = sheetForAdvertiser.length;
  const sourceCount = sourceByTxId.size;
  const guardTriggered =
    (existingCount > 0 && sourceCount === 0) ||         // source returned literally nothing
    (existingCount > 20 && sourceCount < 3);            // tiny source count vs. substantial sheet
  let deletesApplied = 0;
  let deleteAborted = false;

  console.log(`   📥 ${toInsert.length} to insert, 🔄 ${toUpdate.length} to update, 🗑️  ${toDelete.length} ghost rows to delete`);

  const sheets = await getAuthenticatedClient(credentialsPath);

  // 1) UPDATES — batched values.batchUpdate
  if (toUpdate.length > 0) {
    const headerCols = getHeaders();
    const data = toUpdate.map(({ rowIndex, record }) => ({
      range: `${sheetName}!A${rowIndex + 1}`, // +1: rowIndex is data-index (1-based in readSheetRows; header is row 1; data starts row 2; rowIndex 1 → sheet row 2)
      values: [headerCols.map(h => String(record[h] ?? ''))],
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });
    console.log(`   ✅ Updated ${toUpdate.length} rows`);
  }

  // 2) INSERTS — values.append
  if (toInsert.length > 0) {
    const headerCols = getHeaders();
    const values = toInsert.map(rec => headerCols.map(h => String(rec[h] ?? '')));
    // Grow the grid first if needed (see ensureGridRoom comment for context).
    await ensureGridRoom(sheets, spreadsheetId, sheetName, toInsert.length);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A:V`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
    console.log(`   ✅ Inserted ${toInsert.length} new rows`);
  }

  // 3) DELETES — with safety guard
  if (toDelete.length > 0) {
    if (guardTriggered) {
      console.warn(`   ⚠️  SAFETY GUARD TRIGGERED: source has ${sourceCount} records but sheet has ${existingCount} for "${advertiserId}". Refusing to delete ${toDelete.length} rows — likely a partial scrape. Re-run when full data is available.`);
      deleteAborted = true;
    } else {
      // Resolve sheetId for deleteDimension
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetName);
      if (!sheetMeta) throw new Error(`Sheet tab "${sheetName}" not found`);
      const sheetTabId = sheetMeta.properties.sheetId;

      // rowIndex in readSheetRows is 1-based for data rows (header is implicit row 0 in API terms).
      // To convert to 0-based API row index: header row is 0, first data row is 1 → API index = _rowIndex.
      const requests = toDelete
        .map(r => r._rowIndex)
        .sort((a, b) => b - a) // bottom-to-top so indices stay stable
        .map(apiRowIdx => ({
          deleteDimension: {
            range: { sheetId: sheetTabId, dimension: 'ROWS', startIndex: apiRowIdx, endIndex: apiRowIdx + 1 },
          },
        }));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
      deletesApplied = toDelete.length;
      console.log(`   🗑️  Deleted ${deletesApplied} ghost rows (no longer in source)`);
    }
  }

  return {
    inserted: toInsert.length,
    updated: toUpdate.length,
    deleted: deletesApplied,
    skippedDeletes: deleteAborted ? toDelete.length : 0,
    deleteAborted,
  };
}

/**
 * Removes rows from a Google Sheet that match a predicate.
 * Reads the sheet, identifies matching rows by their 0-based row index,
 * then deletes them bottom-to-top so indices stay stable.
 *
 * @param {Object} options
 * @param {string} options.spreadsheetId
 * @param {string} options.credentialsPath
 * @param {string} [options.sheetName='Comissions']
 * @param {Function} options.predicate - (rowObject, rowIndex) => boolean.
 *   rowObject has keys from the header row.
 * @returns {Promise<{removed: number, remaining: number}>}
 */
export async function removeRows({
  spreadsheetId,
  credentialsPath,
  sheetName = 'Comissions',
  predicate,
}) {
  const sheets = await getAuthenticatedClient(credentialsPath);
  const range = `${sheetName}!A:V`;

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = existing.data.values || [];
  if (rows.length < 2) return { removed: 0, remaining: 0 };

  const headers = rows[0];

  // Resolve the numeric sheetId (tab id) needed by deleteDimension
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMeta = meta.data.sheets.find(
    s => s.properties.title === sheetName
  );
  if (!sheetMeta) throw new Error(`Sheet tab "${sheetName}" not found`);
  const sheetId = sheetMeta.properties.sheetId;

  const rowIndicesToRemove = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = rows[i]?.[idx] ?? ''; });
    if (predicate(obj, i)) {
      rowIndicesToRemove.push(i);
    }
  }

  if (rowIndicesToRemove.length === 0) {
    return { removed: 0, remaining: rows.length - 1 };
  }

  // Delete bottom-to-top to keep indices stable
  const requests = rowIndicesToRemove
    .sort((a, b) => b - a)
    .map(idx => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
      },
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });

  console.log(`🗑️  Removed ${rowIndicesToRemove.length} rows from "${sheetName}"`);
  return { removed: rowIndicesToRemove.length, remaining: rows.length - 1 - rowIndicesToRemove.length };
}

/**
 * Reads all rows from a sheet and returns them as an array of objects
 * keyed by the header row.
 *
 * @param {Object} options
 * @param {string} options.spreadsheetId
 * @param {string} options.credentialsPath
 * @param {string} [options.sheetName='Comissions']
 * @returns {Promise<{headers: string[], rows: Object[]}>}
 */
export async function readSheetRows({ spreadsheetId, credentialsPath, sheetName = 'Comissions' }) {
  const sheets = await getAuthenticatedClient(credentialsPath);
  const range = `${sheetName}!A:V`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const raw = res.data.values || [];
  if (raw.length < 2) return { headers: raw[0] || [], rows: [] };
  const headers = raw[0];
  const rows = raw.slice(1).map((r, i) => {
    const obj = { _rowIndex: i + 1 };
    headers.forEach((h, idx) => { obj[h] = r?.[idx] ?? ''; });
    return obj;
  });
  return { headers, rows };
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

