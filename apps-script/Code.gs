/**
 * RSF Session Logger — report endpoint.
 *
 * Deploy: Apps Script → Deploy → New deployment → type "Web app"
 *   Execute as:        Me (your Workspace account — this is what sends the mail)
 *   Who has access:    Anyone
 * "Anyone" is required because the tablet posts without a Google login. The
 * SHARED_TOKEN below is what actually gates the endpoint, so treat it as a
 * password: change it here and in the app's Settings at the same time.
 *
 * Security note, stated plainly: the token ships inside the .apk, so anyone who
 * pulls the app apart can read it. That is acceptable for one tablet in one
 * studio posting attendance rows. Do not reuse this pattern for anything
 * carrying clinical detail or payment data.
 *
 * After pasting this in, set SHEET_ID and SHARED_TOKEN, then Deploy and copy the
 * /exec URL into the app: Settings → Apps Script endpoint URL.
 */

const SHARED_TOKEN = 'CHANGE-ME-then-paste-the-same-value-into-the-app';
const SHEET_ID     = 'PASTE-THE-GOOGLE-SHEET-ID-HERE';
const SHEET_TAB    = 'Sessions';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (!body.token || body.token !== SHARED_TOKEN) {
      return json({ ok: false, error: 'Bad token' });
    }
    if (!body.to) {
      return json({ ok: false, error: 'No destination address' });
    }

    const subject = body.test
      ? 'RSF Session Logger — endpoint test'
      : 'RSF sessions ' + body.range.from + ' to ' + body.range.to;

    const attachment = Utilities.newBlob(body.csv || '', 'text/csv', body.filename || 'sessions.csv');

    const options = {
      name: 'RSF Session Logger',
      attachments: [attachment],
      body: (body.test ? 'This is a test from the tablet. No sessions attached.\n\n' : '') +
            (body.textBody || '')
    };
    if (body.cc) options.cc = body.cc;

    MailApp.sendEmail(body.to, subject, options.body, options);

    /* The Sheet is the real archive — the tablet is only ever the working copy. */
    let appended = 0;
    if (!body.test && SHEET_ID && SHEET_ID.indexOf('PASTE') !== 0) {
      appended = appendToSheet(body);
    }

    return json({
      ok: true,
      message: 'Emailed to ' + body.to + (appended ? ' and appended ' + appended + ' rows' : ''),
      appended: appended
    });

  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/** A GET is only ever a health check — it never sends anything. */
function doGet() {
  return json({ ok: true, service: 'rsf-session-logger', message: 'Endpoint is alive. POST to send a report.' });
}

function appendToSheet(body) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_TAB) || ss.insertSheet(SHEET_TAB);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Sent at', 'Date', 'Start (24h)', 'Client', 'Class', 'Code',
                     'Minutes', 'Billable minutes', 'Status', 'Notes', 'Session ID']);
    sheet.setFrozenRows(1);
  }

  const rows = parseCsvRows(body.csv);
  if (!rows.length) return 0;

  const stamp = new Date();
  const out = rows.map(r => [stamp].concat(r));
  sheet.getRange(sheet.getLastRow() + 1, 1, out.length, out[0].length).setValues(out);
  return out.length;
}

/**
 * Pulls just the per-session detail block out of the CSV — the rows before the
 * first blank line. The totals blocks below it are for the human reading the
 * attachment, not for the archive sheet.
 */
function parseCsvRows(csv) {
  if (!csv) return [];
  const all = Utilities.parseCsv(csv);
  const out = [];
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    if (!row.length || !row[0]) break;
    out.push(row);
  }
  return out;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
