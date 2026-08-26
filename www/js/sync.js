/* Delivery — Apps Script endpoint, mail-app fallback, and file writes.
 *
 * The rule this file exists to enforce: a send is only ever recorded as 'sent'
 * when the endpoint actually confirmed it. A failed POST on bad studio Wi-Fi
 * must look like a failure, not like a success — otherwise a missed month is
 * invisible until accounting asks.
 *
 * That is why the request is NOT made with mode:'no-cors'. no-cors would always
 * appear to succeed because the response is opaque. Instead the body is sent as
 * text/plain, which is a CORS-"simple" request and so skips the preflight that
 * Apps Script cannot answer, while still letting us read the reply.
 */
const Sync = (() => {

  function postReport(report, { test = false } = {}) {
    const url = Store.setting('endpointUrl');
    const token = Store.setting('endpointToken');

    if (!url) {
      return Promise.reject(new Error('No Apps Script endpoint set. Settings → Email delivery.'));
    }

    const payload = {
      token,
      test,
      to: Store.setting('accountingEmail'),
      cc: Store.setting('ccEmail') || '',
      filename: Report.filename(report),
      range: report.range,
      generatedAt: report.generatedAt,
      summary: {
        sessions: report.grand.sessions,
        billableMinutes: report.grand.billableMinutes,
        minutes: report.grand.minutes
      },
      textBody: Report.toPlainText(report),
      csv: Report.toCSV(report)
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    })
      .then(res => res.text().then(text => ({ ok: res.ok, status: res.status, text })))
      .then(({ ok, status, text }) => {
        if (!ok) throw new Error(`Endpoint returned HTTP ${status}. Nothing was sent.`);
        let data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error('Endpoint replied with something unexpected. Nothing was confirmed sent.'); }
        if (!data.ok) throw new Error(data.error || 'Endpoint rejected the report.');
        return data;
      })
      .finally(() => clearTimeout(timeout));
  }

  /* Sends and records the outcome either way — spec gap: send status per report. */
  function sendReport(report) {
    return postReport(report)
      .then(data => Store.recordSend({
        status: 'sent',
        method: 'endpoint',
        range: report.range,
        sessions: report.grand.sessions,
        billableMinutes: report.grand.billableMinutes,
        detail: data.message || 'Delivered'
      }).then(rec => ({ rec, data })))
      .catch(err => Store.recordSend({
        status: 'failed',
        method: 'endpoint',
        range: report.range,
        sessions: report.grand.sessions,
        billableMinutes: report.grand.billableMinutes,
        detail: err.message
      }).then(() => { throw err; }));
  }

  /* Fallback path (§6): hand the report to the tablet's mail client. We cannot
   * know whether the user actually pressed send, so this is recorded as
   * 'handed off', never as 'sent'. */
  function sendViaMailApp(report) {
    const to = Store.setting('accountingEmail');
    const cc = Store.setting('ccEmail');
    const subject = `RSF sessions ${report.range.from} to ${report.range.to}`;
    const body = Report.toPlainText(report);
    const q = [`subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(body)}`];
    if (cc) q.push(`cc=${encodeURIComponent(cc)}`);
    const href = `mailto:${encodeURIComponent(to)}?${q.join('&')}`;

    return Store.recordSend({
      status: 'handoff',
      method: 'mailapp',
      range: report.range,
      sessions: report.grand.sessions,
      billableMinutes: report.grand.billableMinutes,
      detail: 'Opened in the mail app — confirm it was actually sent'
    }).then(() => {
      window.location.href = href;
    });
  }

  /* ---------- file writes (backup, CSV export) ---------- */

  function capFilesystem() {
    const cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.Filesystem) || null;
  }

  /* On Android writes into Documents so the file is reachable from the Files app.
   * In a desktop browser falls back to a normal download. */
  function saveTextFile(filename, text, mime = 'text/plain') {
    const fs = capFilesystem();
    if (fs) {
      return fs.writeFile({
        path: filename,
        data: text,
        directory: 'DOCUMENTS',
        encoding: 'utf8',
        recursive: true
      }).then(res => ({ where: res.uri || 'Documents/' + filename }));
    }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return Promise.resolve({ where: 'Downloads/' + filename });
  }

  function backup() {
    return DB.exportAll().then(data => {
      const payload = {
        app: 'rsf-session-logger',
        schema: 1,
        exportedAt: Store.now(),
        counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
        data
      };
      const name = `rsf-session-logger-backup_${Store.localDate()}.json`;
      return saveTextFile(name, JSON.stringify(payload, null, 2), 'application/json')
        .then(res => Object.assign({ name, counts: payload.counts }, res));
    });
  }

  /* Restore is the only recovery path if the tablet is lost, so it validates the
   * file before touching anything and reports exactly what it loaded. */
  function restoreFromText(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return Promise.reject(new Error('That file is not a valid backup (could not read it as JSON).')); }

    if (!parsed || parsed.app !== 'rsf-session-logger' || !parsed.data) {
      return Promise.reject(new Error('That file is not an RSF Session Logger backup.'));
    }
    const d = parsed.data;
    if (!Array.isArray(d.clients) || !Array.isArray(d.sessions)) {
      return Promise.reject(new Error('That backup is missing its clients or sessions.'));
    }
    return DB.importAll(d, { replace: true })
      .then(() => Store.loadSettings())
      .then(() => ({
        clients: d.clients.length,
        sessions: d.sessions.length,
        sends: (d.sends || []).length,
        exportedAt: parsed.exportedAt
      }));
  }

  return { postReport, sendReport, sendViaMailApp, saveTextFile, backup, restoreFromText };
})();
