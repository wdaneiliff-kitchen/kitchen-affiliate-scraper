import { google } from 'googleapis';
import { readFile } from 'fs/promises';
import { createHash } from 'node:crypto';

const ADVERTISER_ID = 'rpm-pickleball';
const ADVERTISER_NAME = 'RPM Pickleball';
const COMMISSION_RATE = 0.40;

const TRACKING_HEADERS = ['scraped_at', 'total_sales', 'total_earned_usd', 'new_sales', 'new_commissions_usd'];

const MAIN_HEADERS = [
  'transaction_id', 'advertiser_id', 'advertiser_name', 'order_date', 'currency_id',
  'sale_amount', 'commission_amount', 'status', 'click_date', 'validation_date',
  'modified_date', 'sub_id_1', 'sub_id_2', 'sub_id_3', 'sub_id_4', 'sub_id_5',
  'sub_id_6', 'decline_reason', 'paid_to_publisher', 'clickout_url', 'product_title', 'order_ref',
];

function nowCentral() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function generateTransactionId(orderDate, commissionCents) {
  const hash = createHash('sha256')
    .update(`${ADVERTISER_ID}|${orderDate}|${commissionCents}`)
    .digest('base64url')
    .slice(0, 16);
  return `gen_${hash}`;
}

async function getAuthenticatedClient(credentialsPath) {
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf-8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

export async function appendDeltaRow({
  spreadsheetId,
  credentialsPath,
  trackingSheetName = 'RPM Commissions',
  mainSheetName = 'Comissions',
  currentSales,
  currentEarned,
}) {
  const sheets = await getAuthenticatedClient(credentialsPath);

  // Read previous totals from RPM Commissions tracking tab
  const trackingRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${trackingSheetName}!A:E`,
  });
  const trackingRows = trackingRes.data.values || [];

  let prevSales = 0;
  let prevEarned = 0;
  let isFirstRun = false;

  if (trackingRows.length <= 1) {
    isFirstRun = true;
  } else {
    const lastRow = trackingRows[trackingRows.length - 1];
    prevSales = parseInt(lastRow[1] || '0', 10) || 0;
    prevEarned = parseFloat(lastRow[2] || '0') || 0;
  }

  const newSales = isFirstRun ? 0 : Math.max(0, currentSales - prevSales);
  const newEarned = isFirstRun ? 0 : Math.max(0, currentEarned - prevEarned);

  // Append to RPM Commissions tracking tab
  const nextTrackingRow = trackingRows.length + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${trackingSheetName}!A${nextTrackingRow}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        nowCentral(),
        String(currentSales),
        currentEarned.toFixed(2),
        String(newSales),
        newEarned.toFixed(2),
      ]],
    },
  });

  // If there are new commissions, write a row to the main Comissions sheet
  if (newEarned > 0) {
    const orderDate = nowCentral();
    const commissionCents = Math.round(newEarned * 100);
    const saleCents = Math.round(commissionCents / COMMISSION_RATE);
    const transactionId = generateTransactionId(orderDate, commissionCents);

    const record = {
      transaction_id: transactionId,
      advertiser_id: ADVERTISER_ID,
      advertiser_name: ADVERTISER_NAME,
      order_date: orderDate,
      currency_id: 'USD',
      sale_amount: saleCents,
      commission_amount: commissionCents,
      status: 'approved',
      click_date: '', validation_date: '', modified_date: '',
      sub_id_1: '', sub_id_2: '', sub_id_3: '', sub_id_4: '', sub_id_5: '', sub_id_6: '',
      decline_reason: '', paid_to_publisher: '0', clickout_url: '', product_title: '', order_ref: '',
    };

    const dataRow = MAIN_HEADERS.map(h => String(record[h] ?? ''));

    // Deduplicate by transaction_id
    const mainRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${mainSheetName}!A:V`,
    });
    const mainRows = mainRes.data.values || [];
    const existingIds = new Set(mainRows.slice(1).map(r => r[0]));

    if (!existingIds.has(transactionId)) {
      const nextMainRow = mainRows.length + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${mainSheetName}!A${nextMainRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [dataRow] },
      });
      console.log(`✅ Added RPM row to main sheet: $${newEarned.toFixed(2)} commission`);
    } else {
      console.log(`⏭️  Skipped duplicate RPM row`);
    }
  }

  return { newSales, newEarned, isFirstRun };
}

export async function initRpmTab({ credentialsPath, spreadsheetId, sheetName = 'RPM Commissions' }) {
  console.log(`📝 Initializing "${sheetName}" tab...`);
  const sheets = await getAuthenticatedClient(credentialsPath);

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some(s => s.properties.title === sheetName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    console.log(`   ✅ Created tab: "${sheetName}"`);
  } else {
    console.log(`   ℹ️  Tab "${sheetName}" already exists`);
  }

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:E1`,
  });
  if (!existing.data.values || existing.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [TRACKING_HEADERS] },
    });
    console.log(`   ✅ Headers written`);
  }
}
