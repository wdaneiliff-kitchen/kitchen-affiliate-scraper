import { google } from 'googleapis';
import { readFile } from 'fs/promises';

const SHEET_HEADERS = ['scraped_at', 'total_sales', 'total_earned_usd', 'new_sales', 'new_commissions_usd'];

function nowCentral() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date()).replace(',', '');
}

async function getAuthenticatedClient(credentialsPath) {
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf-8'));
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

export async function initRpmTab({ credentialsPath, spreadsheetId, sheetName = 'RPM Commissions' }) {
  console.log(`📝 Initializing "${sheetName}" tab...`);
  const sheets = await getAuthenticatedClient(credentialsPath);

  // Add the tab if it doesn't exist yet
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

  // Write headers if the tab is empty
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:E1`,
  });
  if (!existing.data.values || existing.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
    console.log(`   ✅ Headers written`);
  }
}

export async function appendDeltaRow({
  spreadsheetId,
  credentialsPath,
  sheetName = 'Commissions',
  currentSales,
  currentEarned,
}) {
  const sheets = await getAuthenticatedClient(credentialsPath);
  const range = `${sheetName}!A:E`;

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = existing.data.values || [];

  let prevSales = 0;
  let prevEarned = 0;
  let isFirstRun = false;

  if (rows.length <= 1) {
    isFirstRun = true;
    if (rows.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [SHEET_HEADERS] },
      });
    }
  } else {
    const lastRow = rows[rows.length - 1];
    prevSales = parseInt(lastRow[1] || '0', 10) || 0;
    prevEarned = parseFloat(lastRow[2] || '0') || 0;
  }

  // If totals went down (refund/adjustment), delta is 0 not negative
  const newSales = isFirstRun ? 0 : Math.max(0, currentSales - prevSales);
  const newEarned = isFirstRun ? 0 : Math.max(0, currentEarned - prevEarned);

  const newRow = [
    nowCentral(),
    String(currentSales),
    currentEarned.toFixed(2),
    String(newSales),
    newEarned.toFixed(2),
  ];

  const nextRowIndex = rows.length + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A${nextRowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [newRow] },
  });

  console.log(`✅ Appended row at index ${nextRowIndex}`);
  return { newSales, newEarned, isFirstRun };
}

