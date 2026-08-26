/* Domain layer — clients, sessions, settings.
 *
 * Date rule (matters more than it looks):
 * a session's `date` is a plain local calendar string, 'YYYY-MM-DD', built from
 * the device's local clock components. It is never derived from a UTC timestamp
 * and never round-tripped through toISOString(), so a session logged at 23:58
 * stays on the day it was delivered. `createdAt`/`updatedAt` are separate
 * machine timestamps and are never used for reporting.
 */
const Store = (() => {

  /* ---------- ids & dates ---------- */

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' +
           Math.random().toString(36).slice(2, 8);
  }

  function localDate(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* Parse 'YYYY-MM-DD' as a LOCAL date. new Date('2026-08-25') would parse as
   * UTC midnight and can land on the previous day west of Greenwich. */
  function parseLocal(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(ymd, n) {
    const d = parseLocal(ymd);
    d.setDate(d.getDate() + n);
    return localDate(d);
  }

  function prettyDate(ymd) {
    return parseLocal(ymd).toLocaleDateString(undefined,
      { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function now() { return new Date().toISOString(); }

  /* ---------- settings ---------- */

  const DEFAULTS = {
    accountingEmail: 'accts@rochesterschooloffitness.com',
    ccEmail: 'mido@rochesterschooloffitness.com',
    endpointUrl: '',
    endpointToken: '',
    remindWeekly: true,
    pinHash: '',
    seeded: false
  };

  let cache = {};

  function loadSettings() {
    return DB.all('settings').then(rows => {
      cache = Object.assign({}, DEFAULTS);
      rows.forEach(r => { cache[r.key] = r.value; });
      return cache;
    });
  }

  const setting = (k) => cache[k];

  function setSetting(k, v) {
    cache[k] = v;
    return DB.put('settings', { key: k, value: v });
  }

  /* ---------- clients ---------- */

  function allClients() {
    return DB.all('clients').then(rows =>
      rows.sort((a, b) => a.name.localeCompare(b.name)));
  }

  function activeClients() {
    return allClients().then(rows => rows.filter(c => !c.archived));
  }

  function addClient(name, notes = '') {
    const c = {
      id: uid('c'),
      name: name.trim(),
      notes: notes.trim(),
      archived: false,
      createdAt: now(),
      updatedAt: now()
    };
    return DB.put('clients', c).then(() => c);
  }

  function updateClient(id, patch) {
    return DB.get('clients', id).then(c => {
      if (!c) throw new Error('Client not found');
      Object.assign(c, patch, { updatedAt: now() });
      return DB.put('clients', c).then(() => c);
    });
  }

  /* Archive rather than delete — spec §10.6. History in past reports stays intact. */
  const archiveClient = (id) => updateClient(id, { archived: true });
  const restoreClient = (id) => updateClient(id, { archived: false });

  /* Merge duplicates. Voice entry will eventually produce near-duplicate names
   * ("Mike Kirby" / "Mike Kerby"); without this, one member's history splits in
   * two and neither half is right. Rewrites every session that references the
   * losing id, then archives it. */
  function mergeClients(keepId, dropId) {
    if (keepId === dropId) return Promise.reject(new Error('Pick two different clients'));
    return DB.all('sessions').then(sessions => {
      const touched = [];
      sessions.forEach(s => {
        let changed = false;
        s.attendees.forEach(a => {
          if (a.clientId === dropId) { a.clientId = keepId; changed = true; }
        });
        /* A 2-on-1 that listed both halves of the duplicate would now list the
         * same person twice — collapse it. */
        const seen = new Set();
        const deduped = s.attendees.filter(a => {
          if (seen.has(a.clientId)) return false;
          seen.add(a.clientId); return true;
        });
        if (deduped.length !== s.attendees.length) { s.attendees = deduped; changed = true; }
        if (changed) { s.updatedAt = now(); touched.push(s); }
      });
      return (touched.length ? DB.putMany('sessions', touched) : Promise.resolve())
        .then(() => updateClient(dropId, { archived: true, mergedInto: keepId }))
        .then(() => touched.length);
    });
  }

  /* ---------- sessions ---------- */

  function allSessions() {
    return DB.all('sessions').then(rows => rows.filter(s => !s.deletedAt));
  }

  function sessionsOn(ymd) {
    return allSessions().then(rows =>
      rows.filter(s => s.date === ymd)
          .sort((a, b) => a.startTime.localeCompare(b.startTime)));
  }

  function sessionsBetween(fromYmd, toYmd) {
    return allSessions().then(rows =>
      rows.filter(s => s.date >= fromYmd && s.date <= toYmd)
          .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)));
  }

  function minutesFor(session) {
    const c = CLASS_BY_CODE[session.classCode];
    if (c && c.minutes) return c.minutes;
    return Number(session.customMinutes) || 0;
  }

  function saveSession(input) {
    const s = Object.assign({
      id: uid('s'),
      createdAt: now()
    }, input, { updatedAt: now() });
    if (!s.date) s.date = localDate();
    return DB.put('sessions', s).then(() => s);
  }

  /* Soft delete with a 10-second undo — spec §2. Nothing is ever silently lost. */
  function softDelete(id) {
    return DB.get('sessions', id).then(s => {
      if (!s) throw new Error('Session not found');
      s.deletedAt = now();
      s.updatedAt = now();
      return DB.put('sessions', s).then(() => s);
    });
  }

  function undoDelete(id) {
    return DB.get('sessions', id).then(s => {
      if (!s) return null;
      delete s.deletedAt;
      s.updatedAt = now();
      return DB.put('sessions', s).then(() => s);
    });
  }

  /* Duplicate warning — spec §10.4.
   * Same date, same start time, same class, and at least one shared attendee. */
  function findDuplicates(candidate) {
    return sessionsOn(candidate.date).then(rows => rows.filter(s => {
      if (s.id === candidate.id) return false;
      if (s.startTime !== candidate.startTime) return false;
      if (s.classCode !== candidate.classCode) return false;
      const ids = new Set(s.attendees.map(a => a.clientId));
      return candidate.attendees.some(a => ids.has(a.clientId));
    }));
  }

  /* Repeat last session — spec §10.2. Clones the most recent entry onto a new
   * date, keeping class, time and attendees; statuses reset to attended. */
  function lastSessionBefore(ymd) {
    return allSessions().then(rows => {
      const past = rows.filter(s => s.date <= ymd)
                       .sort((a, b) => (b.date + b.startTime).localeCompare(a.date + a.startTime));
      return past[0] || null;
    });
  }

  /* Running day total — spec §10.3. */
  function dayTotals(sessions) {
    let billable = 0, all = 0;
    sessions.forEach(s => {
      const m = minutesFor(s);
      s.attendees.forEach(a => {
        all += m;
        if (STATUS_BY_CODE[a.status] && STATUS_BY_CODE[a.status].billable) billable += m;
      });
    });
    return { sessions: sessions.length, billableMinutes: billable, allMinutes: all };
  }

  /* ---------- seed roster ---------- */

  const SEED_MEMBERS = [
    'Greg Fiete','Tom Bartlette','Ella Pickles','Robert Pickles','Lexia Cortina',
    'Lucas Cortina','Mark Paganelli','JT Paganelli','Debbie Phillips','Gene Tanucci',
    'Betsi Geherin','Rich Duff','Tristen Conrad','Paul Leclair','Charlie Paganelli',
    'Marc Leclair','Mariann Leclair','Mike Alexander','Ellen Simon','David Villa',
    'Steve Cole','Mary Helen Dolan','Robert Calcagno','Tricia Wilson','Debbie Bernstein',
    'Noah Quinto','Robert Buhite','Mary Jo Korona','Mike Kirby','Christopher Kirby',
    'Nancy Dieter','Kathy Hanson','Diane Paganelli','Greg Johnson','Edwin Monkelbaan',
    'RJ Pickels','Joe Marino','Stacey Trien','Zach Kramer','Bonnie Kramer',
    'Catherine Harmer','Paul Dudley','Thomas Gallaher','Mike Kamish','Pat Buhite',
    'Jan Crumb','John Allen','Jeanne Allen','Matt Geherin','Mike Lenyk',
    'Buck Allen','David Calhoun','Michael Kashtan','Glynnis Kashtan','Howard Kashtan',
    'Dennis Fleming','Marilyn Monkelbaan','Sharon Gordon','Linda Delaney'
  ];

  function seedIfEmpty() {
    return allClients().then(rows => {
      if (rows.length || setting('seeded')) return 0;
      const stamp = now();
      const seeded = SEED_MEMBERS.map(name => ({
        id: uid('c'), name, notes: '', archived: false,
        createdAt: stamp, updatedAt: stamp
      }));
      return DB.putMany('clients', seeded)
        .then(() => setSetting('seeded', true))
        .then(() => seeded.length);
    });
  }

  /* ---------- send history (my addition, see DECISIONS) ---------- */

  function recordSend(rec) {
    const r = Object.assign({ id: uid('snd'), at: now() }, rec);
    return DB.put('sends', r).then(() => r);
  }

  function allSends() {
    return DB.all('sends').then(rows =>
      rows.sort((a, b) => b.at.localeCompare(a.at)));
  }

  function lastSuccessfulSend() {
    return allSends().then(rows => rows.find(r => r.status === 'sent') || null);
  }

  return {
    uid, localDate, parseLocal, addDays, prettyDate, now,
    loadSettings, setting, setSetting, DEFAULTS,
    allClients, activeClients, addClient, updateClient,
    archiveClient, restoreClient, mergeClients,
    allSessions, sessionsOn, sessionsBetween, minutesFor,
    saveSession, softDelete, undoDelete, findDuplicates,
    lastSessionBefore, dayTotals, seedIfEmpty,
    recordSend, allSends, lastSuccessfulSend, SEED_MEMBERS
  };
})();
