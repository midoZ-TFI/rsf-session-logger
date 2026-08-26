/* Resolving native Capacitor plugins without a bundler.
 *
 * This app is plain <script> tags — no npm imports, no build step. That matters
 * here more than anywhere else in the codebase:
 *
 * Capacitor's runtime creates `Capacitor.Plugins` as an EMPTY object. It is only
 * filled in when `registerPlugin()` runs, and that call lives inside each
 * plugin's npm JavaScript wrapper — which a no-bundler app never loads. So
 * reading `Capacitor.Plugins.SpeechRecognition` directly returns undefined on
 * the tablet even though the native plugin is compiled into the .apk and working.
 *
 * The symptom would have been the exact failure the build spec warned about in
 * §5: voice silently falling back to the WebView Speech API, passing every test
 * on the Mac and failing on the Vankyo. Backup would have failed the same way,
 * writing to a browser download instead of Documents — and backup is the only
 * recovery path if the tablet is lost.
 *
 * So plugins are resolved through `Capacitor.registerPlugin()`, which the native
 * bridge does expose globally, with a fallback to `Capacitor.Plugins` in case a
 * wrapper did register one. Results are cached.
 */
const Native = (() => {
  const cache = {};
  const notes = {};

  const isNative = () =>
    !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
       ? window.Capacitor.isNativePlatform()
       : window.Capacitor && window.Capacitor.isNative);

  function plugin(name) {
    if (name in cache) return cache[name];

    const cap = window.Capacitor;
    if (!cap) { notes[name] = 'no Capacitor runtime (browser)'; return (cache[name] = null); }

    /* Preferred: ask the bridge to build the proxy. */
    if (typeof cap.registerPlugin === 'function') {
      try {
        const p = cap.registerPlugin(name);
        if (p) { notes[name] = 'registerPlugin'; return (cache[name] = p); }
      } catch (err) {
        notes[name] = 'registerPlugin threw: ' + err.message;
      }
    }

    /* Fallback: a wrapper already registered it. */
    if (cap.Plugins && cap.Plugins[name]) {
      notes[name] = 'Capacitor.Plugins';
      return (cache[name] = cap.Plugins[name]);
    }

    notes[name] = 'NOT RESOLVED';
    return (cache[name] = null);
  }

  /* Shown in Settings → Diagnostics. If this ever reads "NOT RESOLVED" on the
   * tablet, that is the bug — not the user's microphone. */
  function how(name) {
    if (!(name in cache)) plugin(name);
    return notes[name] || 'unknown';
  }

  return { isNative, plugin, how };
})();
