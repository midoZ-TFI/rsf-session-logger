/* Bootstrap, PIN lock, and event wiring. */
(function () {
  const { $, $$, toast, modal, closeModal, confirmDialog, showScreen } = UI;

  /* ---------- PIN (§10.8) ----------
   * SHA-256 of PIN + a per-install salt. This keeps the PIN out of storage in
   * plain text. It is a screen lock against someone picking the tablet up in a
   * clinical space — it is not device encryption, and it is not claimed to be. */

  function sha256(text) {
    if (window.crypto && crypto.subtle) {
      const bytes = new TextEncoder().encode(text);
      return crypto.subtle.digest('SHA-256', bytes).then(buf =>
        [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''));
    }
    /* WebView without SubtleCrypto: weaker, but still not plain text. */
    let h = 0;
    for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
    return Promise.resolve('fallback:' + (h >>> 0).toString(16));
  }

  function pinSalt() {
    let s = Store.setting('pinSalt');
    if (s) return Promise.resolve(s);
    s = Store.uid('salt');
    return Store.setSetting('pinSalt', s).then(() => s);
  }

  const hashPin = (pin) => pinSalt().then(salt => sha256(salt + ':' + pin));

  function runLock() {
    return new Promise(resolve => {
      const stored = Store.setting('pinHash');
      if (!stored) return resolve();

      const lock = $('#lock');
      lock.classList.remove('hidden');
      let entry = '';

      const paint = () => $$('#lock-dots i').forEach((d, i) =>
        d.classList.toggle('on', i < entry.length));

      $$('.keypad button[data-k]').forEach(b => {
        b.onclick = () => {
          if (b.dataset.k === 'del') { entry = entry.slice(0, -1); return paint(); }
          if (entry.length >= 4) return;
          entry += b.dataset.k;
          paint();
          if (entry.length === 4) {
            hashPin(entry).then(h => {
              if (h === stored) {
                lock.classList.add('hidden');
                resolve();
              } else {
                $('#lock-msg').textContent = 'Wrong PIN — try again';
                entry = '';
                paint();
              }
            });
          }
        };
      });
      paint();
    });
  }

  function promptSetPin() {
    modal(`
      <h3>Set PIN</h3>
      <p class="muted">Four digits, asked on launch. Write it somewhere — there is no reset that keeps your data.</p>
      <label class="field">New PIN
        <input id="pin-a" type="password" inputmode="numeric" maxlength="4" autocomplete="off">
      </label>
      <label class="field">Confirm PIN
        <input id="pin-b" type="password" inputmode="numeric" maxlength="4" autocomplete="off">
      </label>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="cancel">Cancel</button>
        <button class="btn btn-primary" data-act="save">Save PIN</button>
      </div>`, {
      onOpen(card) {
        $('[data-act="cancel"]', card).onclick = closeModal;
        $('[data-act="save"]', card).onclick = () => {
          const a = $('#pin-a', card).value.trim();
          const b = $('#pin-b', card).value.trim();
          if (!/^\d{4}$/.test(a)) return toast('The PIN must be exactly four digits.');
          if (a !== b) return toast('The two PINs do not match.');
          hashPin(a)
            .then(h => Store.setSetting('pinHash', h))
            .then(() => { closeModal(); UI.renderSettings(); toast('PIN set.'); });
        };
      }
    });
  }

  /* ---------- weekly reminder (§9) ---------- */

  function checkSendReminder() {
    if (!Store.setting('remindWeekly')) return;
    Store.lastSuccessfulSend().then(last => {
      const days = last
        ? Math.floor((Date.now() - new Date(last.at).getTime()) / 86400000)
        : null;
      if (last && days < 7) return;
      Store.allSessions().then(all => {
        if (!all.length) return;
        toast(last
          ? `No report has been sent in ${days} days.`
          : 'No report has been emailed yet.', { ms: 8000 });
      });
    });
  }

  /* ---------- wiring ---------- */

  function wire() {
    $$('.tab').forEach(t => t.onclick = () => showScreen(t.dataset.screen));

    /* Log */
    $('#btn-add').onclick = () => UI.openSessionEditor(null);
    $('#day-prev').onclick = () => { UI.setLogDate(Store.addDays(UI.getLogDate(), -1)); UI.renderLog(); };
    $('#day-next').onclick = () => { UI.setLogDate(Store.addDays(UI.getLogDate(), 1)); UI.renderLog(); };
    $('#day-today').onclick = () => { UI.setLogDate(Store.localDate()); UI.renderLog(); };

    /* Repeat last (§10.2) */
    $('#btn-repeat').onclick = () => {
      Store.lastSessionBefore(UI.getLogDate()).then(last => {
        if (!last) return toast('Nothing to repeat yet.');
        const clone = {
          date: UI.getLogDate(),
          startTime: last.startTime,
          classCode: last.classCode,
          customMinutes: last.customMinutes,
          attendees: last.attendees.map(a => ({ clientId: a.clientId, status: 'attended' })),
          notes: ''
        };
        Store.findDuplicates(clone).then(dupes => {
          const go = () => Store.saveSession(clone).then(() => {
            UI.renderLog();
            toast('Repeated the last session onto this day.');
          });
          if (!dupes.length) return go();
          confirmDialog('Possible duplicate',
            'That same class, time and client is already logged on this day. Save anyway?',
            'Save anyway').then(ok => { if (ok) go(); });
        });
      });
    };

    /* Clients */
    /* Wrapped, not passed directly — onclick hands the handler a click Event,
       which openAddClient would otherwise treat as a name to prefill. */
    $('#btn-add-client').onclick = () => UI.openAddClient();
    $('#btn-merge').onclick = UI.openMerge;
    $('#client-mic').onclick = UI.voiceFindClient;
    $('#client-search').oninput = UI.renderClients;
    $('#show-archived').onchange = UI.renderClients;

    /* Report */
    $$('[data-preset]').forEach(b => b.onclick = () => {
      const p = Report.preset(b.dataset.preset);
      $('#rep-from').value = p.from;
      $('#rep-to').value = p.to;
      UI.buildReport();
    });
    $('#btn-build').onclick = UI.buildReport;

    $('#btn-send-endpoint').onclick = () => {
      const rep = UI.getReport();
      if (!rep) return toast('Build the report first.');
      const btn = $('#btn-send-endpoint');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      Sync.sendReport(rep)
        .then(() => toast('Report emailed to accounting and appended to the Sheet.', { ms: 6000 }))
        .catch(err => toast('NOT sent — ' + err.message, { ms: 9000 }))
        .finally(() => {
          btn.disabled = false;
          btn.textContent = 'Email to accounting';
          UI.renderSendHistory();
        });
    };

    $('#btn-send-mailapp').onclick = () => {
      const rep = UI.getReport();
      if (!rep) return toast('Build the report first.');
      Sync.sendViaMailApp(rep).then(() => UI.renderSendHistory());
    };

    $('#btn-save-csv').onclick = () => {
      const rep = UI.getReport();
      if (!rep) return toast('Build the report first.');
      Sync.saveTextFile(Report.filename(rep), Report.toCSV(rep), 'text/csv')
        .then(res => toast('Saved to ' + res.where, { ms: 6000 }))
        .catch(err => toast('Could not save: ' + err.message));
    };

    /* Settings */
    const bindSetting = (sel, key, read = (el) => el.value.trim()) => {
      $(sel).onchange = (e) => Store.setSetting(key, read(e.target));
    };
    bindSetting('#set-to', 'accountingEmail');
    bindSetting('#set-cc', 'ccEmail');
    bindSetting('#set-endpoint', 'endpointUrl');
    bindSetting('#set-token', 'endpointToken');
    $('#set-remind').onchange = (e) => Store.setSetting('remindWeekly', e.target.checked);

    $('#btn-test-endpoint').onclick = () => {
      const status = $('#endpoint-status');
      status.textContent = 'Testing…';
      const stub = {
        range: { from: Store.localDate(), to: Store.localDate() },
        generatedAt: Store.now(),
        rows: [],
        byClient: [], byClass: [], byStatus: [],
        grand: { sessions: 0, lines: 0, minutes: 0, billableMinutes: 0 }
      };
      Sync.postReport(stub, { test: true })
        .then(() => { status.textContent = 'Endpoint answered. A test email was sent.'; })
        .catch(err => { status.textContent = 'Failed: ' + err.message; });
    };

    $('#btn-set-pin').onclick = promptSetPin;
    $('#btn-clear-pin').onclick = () => {
      confirmDialog('Remove the PIN?',
        'Anyone who picks up the tablet will be able to open the app and see member names.',
        'Remove').then(ok => {
        if (!ok) return;
        Store.setSetting('pinHash', '').then(() => { UI.renderSettings(); toast('PIN removed.'); });
      });
    };

    $('#btn-backup').onclick = () => {
      Sync.backup()
        .then(res => {
          $('#backup-status').textContent =
            `Backed up ${res.counts.clients} clients and ${res.counts.sessions} sessions to ${res.where}`;
          toast('Backup written.');
        })
        .catch(err => toast('Backup failed: ' + err.message));
    };

    $('#btn-restore').onclick = () => $('#restore-file').click();
    $('#restore-file').onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      confirmDialog('Restore from backup?',
        'Everything currently on this tablet will be replaced by the contents of that file.',
        'Replace everything').then(ok => {
        if (!ok) { e.target.value = ''; return; }
        file.text()
          .then(Sync.restoreFromText)
          .then(res => {
            toast(`Restored ${res.clients} clients and ${res.sessions} sessions.`, { ms: 7000 });
            $('#backup-status').textContent =
              `Restored from a backup taken ${new Date(res.exportedAt).toLocaleString()}`;
            UI.renderSettings();
            showScreen('log');
          })
          .catch(err => toast(err.message, { ms: 8000 }))
          .finally(() => { e.target.value = ''; });
      });
    };

    $('#btn-diagnostics').onclick = UI.showDiagnostics;

    /* Modal backdrop closes only on the backdrop itself, never on the card —
     * a stray thumb should not discard a half-typed session. */
    $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

    /* Offline chip: the app runs fine offline, but voice and sending do not. */
    const paintOnline = () => $('#offline-chip').classList.toggle('hidden', navigator.onLine);
    window.addEventListener('online', paintOnline);
    window.addEventListener('offline', paintOnline);
    paintOnline();
  }

  /* ---------- start ---------- */

  let started = false;

  function start() {
    if (started) return Promise.resolve();
    started = true;
    return DB.open()
      .then(Store.loadSettings)
      .then(Store.seedIfEmpty)
      .then(n => { if (n) console.log(`Seeded ${n} members.`); })
      .then(runLock)
      .then(() => {
        $('#shell').classList.remove('hidden');
        wire();
        showScreen('log');
        checkSendReminder();
      })
      .catch(err => {
        document.body.innerHTML =
          `<div class="fatal"><h2>The app could not start</h2><p>${UI.esc(err.message)}</p>
           <p class="muted">Your data is still on the tablet. Report this before reinstalling — reinstalling erases it.</p></div>`;
      });
  }

  if (window.Capacitor) {
    document.addEventListener('deviceready', start, { once: true });
    /* Capacitor fires deviceready only with Cordova plugins present; start
     * anyway once the DOM is up so the app never hangs on a blank screen. */
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
