/* Voice entry for client names — spec §5.
 *
 * The important detail: the plain browser SpeechRecognition API does NOT work
 * reliably inside an Android WebView. Built the obvious way this passes on a Mac
 * and fails on the Vankyo. So the native Capacitor plugin is tried FIRST and the
 * browser API is only a desktop-testing fallback.
 *
 * Layer 3 is the Gboard microphone key, which needs no code at all — it works in
 * any text field. Every voice result lands in an editable field for confirmation;
 * nothing is committed to the roster unseen.
 */
const Speech = (() => {

  /* Resolved through Native.plugin, not Capacitor.Plugins directly — see the
   * long note at the top of native.js for why reading Plugins directly returns
   * undefined on the tablet. */
  const nativePlugin = () => Native.plugin('SpeechRecognition');

  const isNative = () => !!nativePlugin();

  function browserImpl() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function available() {
    return isNative() || !!browserImpl();
  }

  /* Whether the DEVICE can actually recognise speech, which is a different
   * question from whether the plugin loaded.
   *
   * Android only offers speech recognition when some app provides a
   * RecognitionService — normally Google's. Budget tablets often ship without
   * it, and then the plugin loads perfectly and `start()` fails with a bare
   * NOT_AVAILABLE. Asking up front turns that into a sentence a person can act
   * on, and lets the UI stop advertising a button that cannot work.
   *
   * Cached after the first successful answer; the answer only changes if the
   * user installs a speech service, which means restarting the app anyway. */
  let deviceOk = null;

  function deviceSupported() {
    if (deviceOk !== null) return Promise.resolve(deviceOk);

    const p = nativePlugin();
    if (!p) {
      deviceOk = !!browserImpl();
      return Promise.resolve(deviceOk);
    }
    if (typeof p.available !== 'function') {
      deviceOk = true;                       // older plugin: assume yes, fail later
      return Promise.resolve(deviceOk);
    }
    return p.available()
      .then(res => { deviceOk = !!(res && res.available); return deviceOk; })
      .catch(() => { deviceOk = false; return deviceOk; });
  }

  const NO_ENGINE =
    'This tablet has no speech recogniser installed, so voice input cannot work. ' +
    'Everything can still be typed. See Settings → Diagnostics.';

  /* Which layer will actually be used — surfaced in Settings → diagnostics so a
   * "voice isn't working" report can be answered without guessing. */
  function activeLayer() {
    if (isNative()) return `native (Android SpeechRecognizer, via ${Native.how('SpeechRecognition')})`;
    /* On a real device the native plugin should always resolve. If it has not,
     * say so loudly rather than reporting the browser fallback as normal — that
     * fallback does not work in an Android WebView, which is the whole reason
     * the native plugin is there. */
    if (Native.isNative()) return `BROKEN — native plugin did not resolve (${Native.how('SpeechRecognition')})`;
    if (browserImpl()) return 'browser SpeechRecognition (testing only)';
    return 'none — use the keyboard microphone key';
  }

  function ensurePermission() {
    const p = nativePlugin();
    if (!p) return Promise.resolve(true);
    return p.checkPermissions()
      .then(res => (res.speechRecognition === 'granted')
        ? true
        : p.requestPermissions().then(r => r.speechRecognition === 'granted'))
      .catch(() => p.requestPermissions().then(r => r.speechRecognition === 'granted').catch(() => false));
  }

  /* Resolves with the best transcript string, or rejects with a plain-language
   * Error the UI can show as-is. */
  function listen() {
    const p = nativePlugin();
    if (p) {
      return deviceSupported().then(ok => {
        if (!ok) throw new Error(NO_ENGINE);
        return ensurePermission();
      }).then(ok => {
        if (!ok) throw new Error('Microphone permission was declined. You can still use the keyboard microphone key.');
        return p.start({
          language: 'en-US',
          maxResults: 3,
          prompt: 'Say the client name',
          partialResults: false,
          popup: false
        });
      }).then(res => {
        const matches = (res && res.matches) || [];
        if (!matches.length) throw new Error("Didn't catch that. Try again, or type the name.");
        return matches[0];
      });
    }

    const Impl = browserImpl();
    if (!Impl) {
      return Promise.reject(new Error('Voice input is not available on this device. Use the microphone key on the keyboard.'));
    }

    return new Promise((resolve, reject) => {
      const rec = new Impl();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      let settled = false;
      rec.onresult = (e) => {
        settled = true;
        resolve(e.results[0][0].transcript);
      };
      rec.onerror = (e) => {
        settled = true;
        reject(new Error(e.error === 'not-allowed'
          ? 'Microphone permission was declined.'
          : "Didn't catch that. Try again, or type the name."));
      };
      rec.onend = () => {
        if (!settled) reject(new Error("Didn't catch that. Try again, or type the name."));
      };
      try { rec.start(); } catch (err) { reject(err); }
    });
  }

  function stop() {
    const p = nativePlugin();
    if (p && p.stop) p.stop().catch(() => {});
  }

  /* Match a spoken phrase against the roster.
   * Speech returns "mike kirby" with no capitals and sometimes a near-miss, so
   * exact match is not enough. Returns ranked candidates; the UI always shows
   * them for confirmation rather than auto-selecting. */
  /* Below this, a "match" is coincidence rather than evidence. Measured against
   * the recorded mis-hearings in TESTING/name-matching.test.js: the weakest real
   * one scores 33, while nonsense tops out around 12. Twenty sits between with
   * room either side. Anything under it is reported as no match, which sends the
   * user to typing — the safe direction to fail in. */
  const MIN_SCORE = 20;

  function matchClients(phrase, clients) {
    const said = normalise(phrase);
    if (!said) return [];
    return clients
      .map(c => ({ client: c, score: score(said, normalise(c.name)) }))
      .filter(x => x.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  function normalise(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* A spoken name with the numeric debris removed. The recogniser turns "two on
   * one" into digits, and if that reaches the roster you get a member called
   * "Charlie Paganelli 211". Used before searching or offering to add a name. */
  function cleanName(phrase) {
    return String(phrase || '')
      .split(/\s+/)
      .filter(w => w && !/^[0-9]+$/.test(w))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Scores word by word rather than on the whole string. Speech mangles one name
   * part at a time — "mike kerby" for Mike Kirby — so a whole-string comparison
   * ranks every other Mike equally and the right answer gets buried. Each spoken
   * word takes its best score against any word of the name, and those are summed,
   * which lets a near-miss surname break the tie. */
  function score(said, name) {
    if (said === name) return 100;
    if (name.startsWith(said) || said.startsWith(name)) return 85;
    if (name.includes(said) || said.includes(name)) return 70;

    const saidWords = said.split(' ').filter(w => w.length > 1);
    const nameWords = name.split(' ');
    if (!saidWords.length) return 0;

    let total = 0;
    for (let i = 0; i < saidWords.length; i++) {
      const solo = bestWordScore(saidWords[i], nameWords);

      /* The recogniser sometimes breaks one surname into two words — Calcagno
       * comes back as "call cagno", and neither half matches anything. Try the
       * pair glued together, and take it only when it genuinely beats scoring
       * the two separately. */
      if (i + 1 < saidWords.length) {
        const joined = bestWordScore(saidWords[i] + saidWords[i + 1], nameWords);
        const next = bestWordScore(saidWords[i + 1], nameWords);
        if (joined > solo + next) { total += joined; i++; continue; }
      }
      total += solo;
    }
    return total * 3;
  }

  /* How well one spoken word matches any word of a name, best signal first. */
  function bestWordScore(w, nameWords) {
    let best = 0;
    nameWords.forEach(n => {
      if (n === w) { best = Math.max(best, 10); return; }
      if (n.startsWith(w) || w.startsWith(n)) { best = Math.max(best, 8); return; }

      const d = editDistance(w, n);
      const tolerance = Math.max(1, Math.floor(Math.max(w.length, n.length) * 0.34));
      if (d <= tolerance) { best = Math.max(best, 7 - d); return; }

      if (w.length > 2 && n.length > 2) {
        const a = soundex(w), b = soundex(n);
        /* A key that is mostly padding carries almost no information: "Joe" and
         * "zzzz" both reduce to 2000, and treating that as a match let nonsense
         * score as highly as a real near-miss. Require at least two coded
         * sounds before believing the key. */
        const solid = (k) => k.replace(/0+$/, '').length >= 2;
        /* Sounds the same all through. */
        if (a === b && solid(a)) { best = Math.max(best, 5); return; }
        /* Sounds the same up to the tail. "Monica" for Monkelbaan and "Culcano"
         * for Calcagno agree on the first three positions and part company after
         * — enough to nominate, not enough to be sure, so it scores low and the
         * user still confirms. */
        if (a.slice(0, 3) === b.slice(0, 3) && solid(a.slice(0, 3))) {
          best = Math.max(best, 4); return;
        }
      }

      /* Last resort: partial credit for a shared opening. Without it, a surname
       * that matches nothing scores zero against everyone, so "Robert <mangled>"
       * ties every Robert on the roster and the winner is whoever sorts first. */
      if (commonPrefix(w, n) >= 3) best = Math.max(best, 3);
    });
    return best;
  }

  /* Soundex — a phonetic key, so names that SOUND alike compare equal even when
   * they are spelled nothing like each other.
   *
   * This exists because edit distance is the wrong tool for misheard names. The
   * recogniser returns "Guerrin" for Geherin: three substitutions apart on paper,
   * far outside any sane spelling tolerance, yet identical out loud. Both reduce
   * to G650. Same for Kirby/Kerby and Fiete/Feet.
   *
   * Its known weakness is the first letter, which is kept as-is — Korona and
   * Corona do not match phonetically. Edit distance still catches those, which
   * is why both run rather than one replacing the other. */
  function soundex(word) {
    const s = String(word).toUpperCase().replace(/[^A-Z]/g, '');
    if (!s) return '';

    const code = (c) => {
      if ('BFPV'.indexOf(c) >= 0) return '1';
      if ('CGJKQSXZ'.indexOf(c) >= 0) return '2';
      if ('DT'.indexOf(c) >= 0) return '3';
      if (c === 'L') return '4';
      if ('MN'.indexOf(c) >= 0) return '5';
      if (c === 'R') return '6';
      return '';                       // vowels, plus H, W, Y
    };

    /* Classic Soundex keeps the first letter verbatim, which is its worst flaw
     * for this job: "Cashtown" and "Kashtan" are the same sound and the same
     * code from the second letter on, yet compare as C235 vs K235. Same for
     * Corona/Korona. Coding the first letter like every other makes the key
     * consistent. Vowel-initial names all fold to A, which is the standard trick. */
    let out = code(s[0]) || 'A';
    let prev = code(s[0]);

    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      const d = code(c);
      if (d && d !== prev) out += d;
      /* H and W are transparent: they do not separate two same-coded letters.
       * A vowel does, which is why prev is cleared for everything else. */
      if (c === 'H' || c === 'W') continue;
      prev = d;
    }
    return (out + '000').slice(0, 4);
  }

  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = cur;
    }
    return prev[n];
  }

  return { available, deviceSupported, isNative, activeLayer, listen, stop,
           matchClients, normalise, cleanName, soundex, MIN_SCORE, NO_ENGINE };
})();
