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
      return ensurePermission().then(ok => {
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
  function matchClients(phrase, clients) {
    const said = normalise(phrase);
    if (!said) return [];
    return clients
      .map(c => ({ client: c, score: score(said, normalise(c.name)) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }

  function normalise(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
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
    saidWords.forEach(w => {
      let best = 0;
      nameWords.forEach(n => {
        if (n === w) { best = Math.max(best, 10); return; }
        if (n.startsWith(w) || w.startsWith(n)) { best = Math.max(best, 8); return; }
        const d = editDistance(w, n);
        const tolerance = Math.max(1, Math.floor(Math.max(w.length, n.length) * 0.34));
        if (d <= tolerance) best = Math.max(best, 7 - d);
      });
      total += best;
    });
    return total * 3;
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

  return { available, isNative, activeLayer, listen, stop, matchClients, normalise };
})();
