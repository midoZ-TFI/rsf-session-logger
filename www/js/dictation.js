/* Dictating a whole session — "Betsi Geherin group class at nine thirty".
 *
 * Deliberately NOT a cloud service and NOT an LLM. The Android speech engine
 * turns sound into text on the device; everything below is plain rule matching
 * against a known 15-item class list, a 59-name roster and a clock. That keeps
 * member names inside the building, keeps it working with the Wi-Fi off, and
 * keeps it free — the same reasoning that picked the native speech plugin.
 *
 * The trade is that it only understands the way sessions are actually described
 * here. It is not conversational. What it cannot parse it reports as missing
 * rather than guessing, and a dictated session ALWAYS opens the editor for
 * confirmation — it is never saved directly. A misparse must cost a correction,
 * never a wrong line on an invoice.
 */
const Dictation = (() => {

  /* ---------- number words ---------- */

  const ONES = {
    zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
  };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50 };

  /* "forty five" -> 45, "nine" -> 9. Returns null if it is not a number word. */
  function wordNumber(text) {
    const parts = String(text).trim().split(/\s+/);
    if (!parts.length) return null;
    if (parts.length === 1) {
      const w = parts[0];
      if (/^\d+$/.test(w)) return Number(w);
      if (w in ONES) return ONES[w];
      if (w in TENS) return TENS[w];
      return null;
    }
    if (parts.length === 2 && parts[0] in TENS && parts[1] in ONES) {
      return TENS[parts[0]] + ONES[parts[1]];
    }
    return null;
  }

  const NUM = '(?:\\d{1,2}|zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|' +
              'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|' +
              '(?:twenty|thirty|forty|fourty|fifty)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?)';

  /* ---------- normalising ---------- */

  /* Keeps digits and colons; folds the punctuation and filler that speech
   * engines sprinkle in. */
  function normalise(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[.’']/g, '')
      .replace(/[,;]/g, ' , ')
      .replace(/\bo'?clock\b/g, ' oclock ')
      .replace(/\ba\.?\s?m\b/g, ' am ')
      .replace(/\bp\.?\s?m\b/g, ' pm ')
      .replace(/[^a-z0-9:, ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- time ---------- */

  /* An hour with no am/pm is genuinely ambiguous. Resolving it to "whichever
   * reading falls in studio hours" beats defaulting to AM: "seven" almost never
   * means 07:00 at the end of the day. Where both readings are plausible, the
   * one nearer the current time wins, because sessions are logged as they
   * happen. */
  function disambiguateHour(h, meridiem, nowHour) {
    if (meridiem === 'am') return h === 12 ? 0 : h;
    if (meridiem === 'pm') return h === 12 ? 12 : (h % 12) + 12;
    if (h === 0 || h > 12) return h;                 // already 24-hour
    const OPEN = 5, CLOSE = 21;
    const a = h;
    const b = (h % 12) + 12;
    const aOk = a >= OPEN && a <= CLOSE;
    const bOk = b >= OPEN && b <= CLOSE;
    if (aOk && !bOk) return a;
    if (bOk && !aOk) return b;
    if (!aOk && !bOk) return a;
    /* Both readings are inside studio hours. Sessions get logged just after they
     * happen, so the recent past beats the future: "six thirty" said at 10am is
     * this morning's class, not tonight's. The future reading carries a penalty
     * rather than being excluded, so an early log still resolves sensibly.
     * Either way the editor opens with the time on screen, so a wrong guess
     * costs one tap on the grid. */
    const cost = (x) => (x <= nowHour ? nowHour - x : (x - nowHour) + 6);
    return cost(a) <= cost(b) ? a : b;
  }

  const snap15 = (m) => Math.min(45, Math.round(m / 15) * 15);

  /* Each matcher returns {h, m, meridiem, text} or null. Ordered most specific
   * first — "half past nine" must be tried before a bare "nine". */
  function extractTime(s, now = new Date()) {
    const nowHour = now.getHours();
    const tries = [
      // 14:30 / 9:05
      { re: new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\b`),
        take: (m) => ({ h: +m[1], m: +m[2], meridiem: m[3] }) },
      // quarter to ten
      { re: new RegExp(`\\bquarter to (${NUM})\\b`),
        take: (m) => { const h = wordNumber(m[1]); return h == null ? null : { h: (h + 23) % 24, m: 45 }; } },
      // quarter past nine / half past nine
      { re: new RegExp(`\\b(quarter|half) past (${NUM})\\s*(am|pm)?\\b`),
        take: (m) => { const h = wordNumber(m[2]); return h == null ? null
          : { h, m: m[1] === 'half' ? 30 : 15, meridiem: m[3] }; } },
      // nine thirty / nine fifteen am / fourteen thirty
      { re: new RegExp(`\\b(${NUM})[ -](${NUM})\\s*(am|pm)?\\b`),
        take: (m) => { const h = wordNumber(m[1]), mi = wordNumber(m[2]);
          if (h == null || mi == null || h > 23 || mi > 59) return null;
          return { h, m: mi, meridiem: m[3] }; } },
      // nine oclock / nine am
      { re: new RegExp(`\\b(${NUM})\\s*(?:oclock)?\\s*(am|pm)\\b`),
        take: (m) => { const h = wordNumber(m[1]); return h == null ? null : { h, m: 0, meridiem: m[2] }; } },
      { re: new RegExp(`\\b(${NUM})\\s+oclock\\b`),
        take: (m) => { const h = wordNumber(m[1]); return h == null ? null : { h, m: 0 }; } },
      { re: /\b(noon|midday)\b/,   take: () => ({ h: 12, m: 0 }) },
      { re: /\bmidnight\b/,        take: () => ({ h: 0, m: 0 }) },
      // 930 / 1430 spoken as one run of digits
      { re: /\b(\d{3,4})\s*(am|pm)?\b/,
        take: (m) => { const raw = m[1];
          const h = +raw.slice(0, raw.length - 2), mi = +raw.slice(-2);
          if (h > 23 || mi > 59) return null;
          return { h, m: mi, meridiem: m[2] }; } },
      // bare "at nine"
      { re: new RegExp(`\\bat (${NUM})\\b`),
        take: (m) => { const h = wordNumber(m[1]); return h == null || h > 23 ? null : { h, m: 0 }; } }
    ];

    for (const t of tries) {
      const m = s.match(t.re);
      if (!m) continue;
      const got = t.take(m);
      if (!got) continue;
      const h = disambiguateHour(got.h, got.meridiem, nowHour);
      if (h < 0 || h > 23) continue;
      return {
        startTime: String(h).padStart(2, '0') + ':' + String(snap15(got.m)).padStart(2, '0'),
        rawMinutes: got.m,
        rest: s.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
      };
    }
    return null;
  }

  /* ---------- class type ---------- */

  /* Matched longest-phrase-first so "nutrition group" beats "group". */
  const CLASS_PHRASES = [
    { p: 'nutrition group',        base: 'NUTG' },
    { p: 'group nutrition',        base: 'NUTG' },
    { p: 'nutrition individual',   base: 'NUTI' },
    { p: 'individual nutrition',   base: 'NUTI' },
    { p: 'nutrition one on one',   base: 'NUTI' },
    { p: 'nutrition',              base: 'NUTI' },
    { p: 'red light therapy',      fixed: 'RLT30' },
    { p: 'red light',              fixed: 'RLT30' },
    { p: 'stretching',             fixed: 'STR30' },
    { p: 'stretch',                fixed: 'STR30' },
    { p: 'group boxing',           fixed: 'BOX30' },
    { p: 'boxing',                 fixed: 'BOX30' },
    { p: 'athletes class',         fixed: 'ATH60' },
    { p: 'athletes',               fixed: 'ATH60' },
    { p: 'athlete',                fixed: 'ATH60' },
    { p: '2 on 1',                 base: 'TWO' },
    { p: 'two on one',             base: 'TWO' },
    { p: 'two on 1',               base: 'TWO' },
    { p: '2 on one',               base: 'TWO' },
    { p: 'group class',            base: 'GRP' },
    { p: 'group',                  base: 'GRP' },
    { p: 'individual class',       base: 'IND' },
    { p: 'individual',             base: 'IND' },
    { p: 'one on one',             base: 'IND' },
    { p: '1 on 1',                 base: 'IND' },
    { p: 'personal training',      base: 'IND' },
    { p: 'personal',               base: 'IND' },
    { p: 'private',                base: 'IND' }
  ];

  /* A bare number is NEVER a duration — it must carry a unit. Without this rule
   * "at nine thirty" loses its minutes to a phantom 30-minute duration, and
   * "2 on 1 thirty minutes" is unparseable. "hour" is itself the unit. */
  const DURATION_PHRASES = [
    { re: /\bhalf (?:an? )?hour\b/,                                          mins: 30 },
    { re: /\b(?:one |1 |an? )?(?:full )?hour\b/,                             mins: 60 },
    { re: /\b(?:30|thirty)\s*(?:minute|minutes|min|mins)\b/,                 mins: 30 },
    { re: /\b(?:60|sixty)\s*(?:minute|minutes|min|mins)\b/,                  mins: 60 },
    { re: /\b(?:45|forty[ -]five|fourty[ -]five)\s*(?:minute|minutes|min|mins)\b/, mins: 45 },
    { re: /\b(?:90|ninety)\s*(?:minute|minutes|min|mins)\b/,                 mins: 90 }
  ];

  function extractClass(s) {
    let rest = s;

    /* Class phrase first. "2 on 1" and "one on one" contain digits and number
     * words that the time and duration matchers would otherwise swallow. */
    let found = null;
    for (const c of CLASS_PHRASES) {
      const re = new RegExp('\\b' + c.p.replace(/ /g, '\\s+') + '\\b');
      const m = rest.match(re);
      if (!m) continue;
      found = c;
      rest = rest.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
      break;
    }

    let duration = null;
    for (const d of DURATION_PHRASES) {
      const m = rest.match(d.re);
      if (m) { duration = d.mins; rest = rest.replace(m[0], ' ').replace(/\s+/g, ' ').trim(); break; }
    }

    if (!found) {
      /* Duration on its own is enough to pick an individual session, which is
       * the commonest entry: "Rich Duff thirty minutes at ten". */
      if (duration) return { classCode: duration === 30 ? 'IND30' : 'IND60', duration, rest, assumed: true };
      return { classCode: null, duration, rest };
    }

    if (found.fixed) return { classCode: found.fixed, duration, rest };

    /* A base type still needs a length. Default 60 unless a duration was said. */
    const mins = duration === 30 ? 30 : 60;
    const code = found.base + mins;
    return {
      classCode: CLASS_BY_CODE[code] ? code : (found.base + '60'),
      duration,
      rest,
      assumedDuration: duration == null
    };
  }

  /* ---------- status ---------- */

  const STATUS_PHRASES = [
    { re: /\bno[ -]?show(?:ed)?\b/,                       code: 'noshow' },
    { re: /\bcancell?ed? (?:with )?(?:notice|advance)\b/, code: 'cancel_ok' },
    { re: /\blate cancell?(?:ed|ation)?\b/,               code: 'cancel_late' },
    { re: /\bcancell?ed? late\b/,                         code: 'cancel_late' },
    { re: /\bcancell?ed?\b/,                              code: 'cancel_ok' }
  ];

  function extractStatus(s) {
    for (const st of STATUS_PHRASES) {
      const m = s.match(st.re);
      if (m) return { status: st.code, rest: s.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
    }
    return { status: 'attended', rest: s };
  }

  /* ---------- names ---------- */

  const FILLER = new Set(['at','on','with','and','the','a','an','for','to','of',
                          'session','class','today','please','add','log','book','did','do','was','were','is']);

  /* What is left after class, time and status have been removed should be names,
   * possibly several joined by "and". Each chunk is matched against the roster
   * with the same fuzzy matcher the name mic uses. */
  /* Status is read PER CHUNK, not once for the whole phrase. In
   * "Rich Duff and Steve Cole at eight, Mike Kirby no show" only Mike Kirby is
   * the no-show; applying it to everyone would bill two attended sessions as
   * missed. A status with no name attached ("... no show" alone) becomes the
   * default for anyone who did not state their own. */
  function extractClients(rest, clients) {
    const rawChunks = rest.split(/\s+,\s+|\band\b|\bplus\b/);

    const picked = [];
    const unmatched = [];
    const seen = new Set();
    let loneStatus = null;

    rawChunks.forEach(raw => {
      const st = extractStatus(raw);
      const chunk = st.rest.split(/\s+/).filter(w => w && !FILLER.has(w)).join(' ').trim();

      if (!chunk) {
        if (st.status !== 'attended') loneStatus = st.status;
        return;
      }
      /* Leftover bare numbers are never names — "individual sixty" leaves
       * "sixty" behind once the class is stripped. */
      if (wordNumber(chunk) != null) return;

      const ranked = Speech.matchClients(chunk, clients);
      if (!ranked.length) { unmatched.push(chunk); return; }

      /* Auto-accept only a CLEAR winner — decided by the margin over the runner
       * up, not by absolute score. A surname alone ("Paganelli") scores highly
       * against four different members; picking the first would silently bill
       * the wrong person. A tie goes to the confirmation list instead. */
      const best = ranked[0];
      const runnerUp = ranked[1];
      const clear = !runnerUp || (best.score - runnerUp.score) >= 15;
      if (!clear) { unmatched.push(chunk); return; }
      if (seen.has(best.client.id)) return;
      seen.add(best.client.id);
      picked.push({ client: best.client, status: st.status });
    });

    if (loneStatus) {
      picked.forEach(p => { if (p.status === 'attended') p.status = loneStatus; });
    }

    return { attendees: picked, clients: picked.map(p => p.client), unmatched, loneStatus };
  }

  /* ---------- the whole thing ---------- */

  function parse(phrase, clients, now = new Date()) {
    const original = String(phrase || '');
    let s = normalise(original);

    /* Order matters. Class comes out BEFORE time: "2 on 1" and "one on one"
     * contain digits and number words, and a time matcher run first reads
     * "2 on 1 thirty minutes" as 1:30. Status is handled per name, inside
     * extractClients, not stripped globally here. */
    const k = extractClass(s); s = k.rest;
    const t = extractTime(s, now); if (t) s = t.rest;
    const who = extractClients(s, clients);

    const missing = [];
    if (!who.clients.length) missing.push('who');
    if (!k.classCode) missing.push('class');
    if (!t) missing.push('time');

    const firstFlagged = who.attendees.find(a => a.status !== 'attended');

    return {
      original,
      startTime: t ? t.startTime : null,
      classCode: k.classCode,
      minutes: k.classCode && CLASS_BY_CODE[k.classCode] ? CLASS_BY_CODE[k.classCode].minutes : null,
      customMinutes: k.duration || null,
      status: firstFlagged ? firstFlagged.status : (who.loneStatus || 'attended'),
      attendees: who.attendees,
      clients: who.clients,
      unmatched: who.unmatched,
      missing,
      assumedDuration: !!k.assumedDuration,
      /* A one-line summary of what was understood, shown above the editor so a
       * misparse is obvious before saving rather than after. */
      summary: summarise(t, k, who)
    };
  }

  function summarise(t, k, who) {
    const bits = [];
    bits.push(who.attendees.length
      ? who.attendees.map(a => {
          const st = STATUS_BY_CODE[a.status];
          return a.status === 'attended' ? a.client.name
                                         : `${a.client.name} (${st ? st.label : a.status})`;
        }).join(', ')
      : 'nobody recognised');
    bits.push(k.classCode ? classLabel(k.classCode) : 'no class heard');
    bits.push(t ? t.startTime : 'no time heard');
    return bits.join(' · ');
  }

  return { parse, normalise, extractTime, extractClass, extractStatus, wordNumber, disambiguateHour };
})();

/* Node can require this file for tests; the browser just gets the global. */
if (typeof module !== 'undefined' && module.exports) module.exports = { Dictation };
