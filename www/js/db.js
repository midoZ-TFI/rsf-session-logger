/* IndexedDB wrapper — spec §9.
 *
 * IndexedDB is used rather than localStorage because Android does not clear it
 * the way it clears browser cache, and because it survives an app update as
 * long as the .apk is signed with the same keystore.
 *
 * Deliberately tiny: open(), get/put/del/all() and a transaction helper. No
 * ORM, no library. A future maintainer should be able to read this in a sitting.
 */
const DB = (() => {
  const NAME = 'rsf-session-logger';
  const VERSION = 1;
  const STORES = ['clients', 'sessions', 'settings', 'sends'];
  let db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('clients')) {
          d.createObjectStore('clients', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('sessions')) {
          const s = d.createObjectStore('sessions', { keyPath: 'id' });
          s.createIndex('date', 'date');
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains('sends')) {
          d.createObjectStore('sends', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const os = t.objectStore(store);
      let out;
      try { out = fn(os); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const all  = (store) => tx(store, 'readonly',  os => os.getAll());
  const get  = (store, key) => tx(store, 'readonly',  os => os.get(key));
  const put  = (store, val) => tx(store, 'readwrite', os => os.put(val));
  const del  = (store, key) => tx(store, 'readwrite', os => os.delete(key));

  function putMany(store, vals) {
    return tx(store, 'readwrite', os => { vals.forEach(v => os.put(v)); });
  }

  function clear(store) {
    return tx(store, 'readwrite', os => os.clear());
  }

  /* Used by backup/restore and diagnostics. */
  function exportAll() {
    return Promise.all(STORES.map(all)).then(results => {
      const out = {};
      STORES.forEach((s, i) => { out[s] = results[i]; });
      return out;
    });
  }

  function importAll(data, { replace = true } = {}) {
    return open().then(() => {
      const jobs = STORES.map(s => {
        const rows = Array.isArray(data[s]) ? data[s] : [];
        const step = replace ? clear(s) : Promise.resolve();
        return step.then(() => rows.length ? putMany(s, rows) : null);
      });
      return Promise.all(jobs);
    });
  }

  return { open, all, get, put, del, putMany, clear, exportAll, importAll, STORES };
})();
