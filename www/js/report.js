/* Report building — spec §6.
 *
 * One row per attendee, not per session: a group class of eight produces eight
 * billable lines, which is what accounting needs to see. The session itself is
 * still identifiable via sessionId so rows can be grouped back together.
 */
const Report = (() => {

  function build(fromYmd, toYmd) {
    return Promise.all([
      Store.sessionsBetween(fromYmd, toYmd),
      Store.allClients()
    ]).then(([sessions, clients]) => {
      const nameById = Object.fromEntries(clients.map(c => [c.id, c.name]));
      const rows = [];

      sessions.forEach(s => {
        const minutes = Store.minutesFor(s);
        const klass = CLASS_BY_CODE[s.classCode] || { label: s.classCode };
        s.attendees.forEach(a => {
          const st = STATUS_BY_CODE[a.status] || STATUS_BY_CODE.attended;
          rows.push({
            sessionId: s.id,
            date: s.date,
            startTime: s.startTime,
            client: nameById[a.clientId] || '(removed client)',
            classCode: s.classCode,
            classLabel: klass.label,
            minutes,
            billableMinutes: st.billable ? minutes : 0,
            status: st.label,
            statusCode: st.code,
            notes: s.notes || ''
          });
        });
      });

      rows.sort((a, b) =>
        (a.date + a.startTime + a.client).localeCompare(b.date + b.startTime + b.client));

      return {
        range: { from: fromYmd, to: toYmd },
        generatedAt: Store.now(),
        rows,
        byClient: totalsBy(rows, r => r.client),
        byClass: totalsBy(rows, r => `${r.classLabel} (${r.classCode})`),
        byStatus: totalsBy(rows, r => r.status),
        grand: {
          sessions: new Set(rows.map(r => r.sessionId)).size,
          lines: rows.length,
          minutes: rows.reduce((n, r) => n + r.minutes, 0),
          billableMinutes: rows.reduce((n, r) => n + r.billableMinutes, 0)
        }
      };
    });
  }

  function totalsBy(rows, keyFn) {
    const map = new Map();
    rows.forEach(r => {
      const k = keyFn(r);
      const cur = map.get(k) || { key: k, lines: 0, minutes: 0, billableMinutes: 0 };
      cur.lines += 1;
      cur.minutes += r.minutes;
      cur.billableMinutes += r.billableMinutes;
      map.set(k, cur);
    });
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /* CSV, not a pasted HTML table — accounting needs to sort and sum it. */
  function toCSV(report) {
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [];
    lines.push(['Date', 'Start (24h)', 'Client', 'Class', 'Code', 'Minutes',
                'Billable minutes', 'Status', 'Notes', 'Session ID'].join(','));
    report.rows.forEach(r => {
      lines.push([r.date, r.startTime, r.client, r.classLabel, r.classCode,
                  r.minutes, r.billableMinutes, r.status, r.notes, r.sessionId]
                 .map(esc).join(','));
    });
    lines.push('');
    lines.push('Totals by client');
    lines.push(['Client', 'Sessions', 'Minutes', 'Billable minutes'].join(','));
    report.byClient.forEach(t =>
      lines.push([t.key, t.lines, t.minutes, t.billableMinutes].map(esc).join(',')));
    lines.push('');
    lines.push('Totals by class');
    lines.push(['Class', 'Sessions', 'Minutes', 'Billable minutes'].join(','));
    report.byClass.forEach(t =>
      lines.push([t.key, t.lines, t.minutes, t.billableMinutes].map(esc).join(',')));
    lines.push('');
    lines.push('Totals by status');
    lines.push(['Status', 'Lines', 'Minutes', 'Billable minutes'].join(','));
    report.byStatus.forEach(t =>
      lines.push([t.key, t.lines, t.minutes, t.billableMinutes].map(esc).join(',')));
    lines.push('');
    lines.push(['Grand total', report.grand.sessions + ' sessions',
                report.grand.minutes + ' minutes',
                report.grand.billableMinutes + ' billable minutes'].map(esc).join(','));
    return lines.join('\r\n');
  }

  /* Plain-text body for the mail-app fallback path (§6). Kept short — the CSV is
   * the artefact, this is the human summary. */
  function toPlainText(report) {
    const L = [];
    L.push(`RSF session report — ${report.range.from} to ${report.range.to}`);
    L.push('');
    L.push(`Sessions: ${report.grand.sessions}`);
    L.push(`Billable minutes: ${report.grand.billableMinutes}`);
    L.push(`Total minutes logged: ${report.grand.minutes}`);
    L.push('');
    L.push('Totals by client');
    report.byClient.forEach(t => L.push(`  ${t.key}: ${t.lines} sessions, ${t.billableMinutes} billable min`));
    L.push('');
    L.push('Totals by class');
    report.byClass.forEach(t => L.push(`  ${t.key}: ${t.lines} sessions, ${t.billableMinutes} billable min`));
    L.push('');
    L.push('Totals by status');
    report.byStatus.forEach(t => L.push(`  ${t.key}: ${t.lines}`));
    L.push('');
    L.push('Detail');
    report.rows.forEach(r =>
      L.push(`  ${r.date} ${r.startTime}  ${r.client}  ${r.classLabel}  ${r.minutes}m  ${r.status}`));
    return L.join('\n');
  }

  function filename(report) {
    return `rsf-sessions_${report.range.from}_to_${report.range.to}.csv`;
  }

  /* Date-range presets — spec §10.7. */
  function preset(name, today = Store.localDate()) {
    const d = Store.parseLocal(today);
    const p = n => String(n).padStart(2, '0');
    const ymd = (dt) => `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;

    if (name === 'this-month') {
      return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)),
               to:   ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
    }
    if (name === 'last-month') {
      return { from: ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)),
               to:   ymd(new Date(d.getFullYear(), d.getMonth(), 0)) };
    }
    /* Weeks run Monday–Sunday. */
    const dow = (d.getDay() + 6) % 7;
    if (name === 'this-week') {
      const mon = new Date(d); mon.setDate(d.getDate() - dow);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { from: ymd(mon), to: ymd(sun) };
    }
    if (name === 'last-week') {
      const mon = new Date(d); mon.setDate(d.getDate() - dow - 7);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { from: ymd(mon), to: ymd(sun) };
    }
    return { from: today, to: today };
  }

  return { build, toCSV, toPlainText, filename, preset };
})();
