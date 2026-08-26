/* Screens and interaction.
 *
 * Plain DOM, no framework. Everything on this screen is touched with a thumb on
 * a tablet held in two hands, so targets are large and destructive actions are
 * always confirmable or undoable.
 */
const UI = (() => {

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* Working date for the Log screen. Defaults to the device's local today. */
  let logDate = Store.localDate();
  let speechOk = null;
  let currentReport = null;
  let undoTimer = null;

  /* ---------- toast / undo ---------- */

  function toast(msg, { actionLabel = null, onAction = null, ms = 4000 } = {}) {
    const el = $('#toast');
    const btn = $('#toast-action');
    $('#toast-msg').textContent = msg;
    clearTimeout(undoTimer);
    if (actionLabel) {
      btn.textContent = actionLabel;
      btn.classList.remove('hidden');
      btn.onclick = () => { hideToast(); onAction && onAction(); };
    } else {
      btn.classList.add('hidden');
      btn.onclick = null;
    }
    el.classList.remove('hidden');
    undoTimer = setTimeout(hideToast, ms);
  }

  function hideToast() {
    clearTimeout(undoTimer);
    $('#toast').classList.add('hidden');
  }

  /* ---------- modal ---------- */

  function modal(html, { onOpen } = {}) {
    const host = $('#modal');
    $('#modal-card').innerHTML = html;
    host.classList.remove('hidden');
    if (onOpen) onOpen($('#modal-card'));
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
    $('#modal-card').innerHTML = '';
  }

  function confirmDialog(title, message, confirmLabel = 'Confirm') {
    return new Promise(resolve => {
      modal(`
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-danger" data-act="ok">${esc(confirmLabel)}</button>
        </div>`, {
        onOpen(card) {
          $('[data-act="cancel"]', card).onclick = () => { closeModal(); resolve(false); };
          $('[data-act="ok"]', card).onclick     = () => { closeModal(); resolve(true); };
        }
      });
    });
  }

  /* ---------- navigation ---------- */

  function showScreen(name) {
    $$('.screen').forEach(s => s.classList.add('hidden'));
    $('#screen-' + name).classList.remove('hidden');
    $$('.tab').forEach(t => t.classList.toggle('tab-active', t.dataset.screen === name));
    if (name === 'log') renderLog();
    if (name === 'clients') renderClients();
    if (name === 'report') renderReportScreen();
    if (name === 'settings') renderSettings();
  }

  /* ══════════════════ LOG ══════════════════ */

  function renderLog() {
    $('#log-date-label').textContent = Store.prettyDate(logDate) +
      (logDate === Store.localDate() ? '' : '  •  not today');
    $('#today-chip').textContent = Store.prettyDate(Store.localDate());

    return Promise.all([Store.sessionsOn(logDate), Store.allClients()])
      .then(([sessions, clients]) => {
        const nameById = Object.fromEntries(clients.map(c => [c.id, c.name]));
        const t = Store.dayTotals(sessions);

        $('#day-total').innerHTML = `
          <div class="dt-item"><b>${t.sessions}</b><span>sessions</span></div>
          <div class="dt-item"><b>${t.billableMinutes}</b><span>billable min</span></div>
          <div class="dt-item"><b>${(t.billableMinutes / 60).toFixed(1)}</b><span>billable hrs</span></div>`;

        if (!sessions.length) {
          $('#log-list').innerHTML =
            `<p class="empty">No sessions logged for this day yet.</p>`;
          return;
        }

        $('#log-list').innerHTML = sessions.map(s => {
          const k = CLASS_BY_CODE[s.classCode] || { label: s.classCode };
          const mins = Store.minutesFor(s);
          const people = s.attendees.map(a => {
            const st = STATUS_BY_CODE[a.status] || STATUS_BY_CODE.attended;
            const cls = a.status === 'attended' ? '' : ' att-flag';
            return `<span class="att${cls}">${esc(nameById[a.clientId] || '(removed)')}` +
                   (a.status === 'attended' ? '' : ` <i>${esc(st.short)}</i>`) + `</span>`;
          }).join('');
          return `
            <div class="row" data-id="${s.id}">
              <div class="row-time">${esc(s.startTime)}</div>
              <div class="row-main">
                <div class="row-title">${esc(k.label)} <span class="muted">· ${mins} min</span></div>
                <div class="row-people">${people}</div>
                ${s.notes ? `<div class="row-notes">${esc(s.notes)}</div>` : ''}
              </div>
              <div class="row-go">›</div>
            </div>`;
        }).join('');

        $$('#log-list .row').forEach(r => {
          r.onclick = () => openSessionEditor(r.dataset.id);
        });
      });
  }

  /* When the device has no speech recogniser, hide the voice controls instead of
   * leaving buttons that can only ever produce an error, and say why once. */
  function applySpeechAvailability(ok) {
    speechOk = ok;
    ['#btn-dictate', '#client-mic'].forEach(sel => {
      const el = $(sel);
      if (el) el.classList.toggle('hidden', !ok);
    });
    const hint = $('.dictate-hint');
    if (hint) {
      if (ok) { hint.classList.remove('hidden'); return; }
      hint.classList.remove('hidden');
      hint.innerHTML = 'Voice input is unavailable — this tablet has no speech ' +
        'recogniser installed. Type the session in the box above instead, or use ' +
        '<b>+ Add session</b>. See <b>Settings → Show diagnostics</b>.';
    }
  }

  /* ---------- session editor ---------- */

  function openSessionEditor(sessionId) {
    Promise.all([
      sessionId ? DB.get('sessions', sessionId) : Promise.resolve(null),
      Store.activeClients(),
      Store.allClients()
    ]).then(([existing, active, everyone]) => {
      /* An archived client already on a saved session must stay selectable, or
       * editing an old entry would silently drop them. */
      const pickable = existing
        ? dedupeById([...active, ...everyone.filter(c =>
            existing.attendees.some(a => a.clientId === c.id))])
        : active;

      const draft = existing
        ? JSON.parse(JSON.stringify(existing))
        : { date: logDate, startTime: defaultTime(), classCode: 'IND60',
            customMinutes: 60, attendees: [], notes: '' };

      renderSessionEditor(draft, pickable, !!existing);
    });
  }

  /* Dictating a whole session. The parsed result NEVER saves directly — it opens
   * the editor prefilled with a banner saying what was understood, so a misparse
   * costs one correction instead of a wrong line on an invoice. */
  /* A whole session is a sentence, so this uses the long-listen path: the mic
   * stays open through pauses, the words appear as they are recognised, and a
   * second tap ends it. Tapping again while listening stops rather than
   * restarting -- otherwise the obvious gesture throws away what you just said. */
  let dictating = false;

  function dictateSession() {
    const btn = $('#btn-dictate');
    const hint = $('.dictate-hint');
    const hintHTML = hint ? hint.innerHTML : '';

    if (dictating) { Speech.stopLong(); return; }

    const restore = () => {
      dictating = false;
      btn.disabled = false;
      btn.classList.remove('btn-listening');
      btn.textContent = '🎤 Say a whole session';
      if (hint) hint.innerHTML = hintHTML;
    };

    dictating = true;
    btn.classList.add('btn-listening');
    btn.textContent = '● Listening — tap to stop';

    Speech.listenLong({
      onPartial: (text) => { if (hint) hint.textContent = '“' + text + '”'; }
    })
      .then(phrase => sessionFromPhrase(phrase, 'Heard'))
      .catch(err => toast(err.message))
      .finally(restore);
  }

  /* Same parser, typed instead of spoken. */
  function typeSession() {
    const input = $('#type-session');
    const phrase = input.value.trim();
    if (!phrase) return toast('Type a session first, e.g. "Rich Duff individual at ten".');
    sessionFromPhrase(phrase, 'Read')
      .then(ok => { if (ok) input.value = ''; })
      .catch(err => toast(err.message));
  }

  /* Shared by both. Resolves true when the editor opened. */
  function sessionFromPhrase(phrase, verb) {
    return Store.activeClients().then(clients => {
        const p = Dictation.parse(phrase, clients);

        if (!p.clients.length && !p.classCode && !p.startTime) {
          toast(`${verb} "${phrase}" — couldn't make a session out of that.`, { ms: 7000 });
          return false;
        }

        const draft = {
          date: logDate,
          startTime: p.startTime || defaultTime(),
          classCode: p.classCode || 'IND60',
          customMinutes: p.customMinutes || 60,
          attendees: p.attendees.map(a => ({ clientId: a.client.id, status: a.status })),
          notes: ''
        };

        const klass = CLASS_BY_CODE[draft.classCode];
        const lim = klass && klass.seats !== 'many' ? klass.seats : Infinity;
        if (draft.attendees.length > lim) draft.attendees = draft.attendees.slice(0, lim);

        renderSessionEditor(draft, clients, false, {
          verb: verb,
          heard: p.original,
          summary: p.summary,
          missing: p.missing,
          unmatched: p.unmatched,
          ambiguous: p.ambiguous,
          /* Seed the picker with the ambiguous word so the list is already
             narrowed to the people it could be — one tap, not a re-search. */
          searchSeed: (p.ambiguous && p.ambiguous.length) ? p.ambiguous[0].phrase : ''
        });
        return true;
      });
  }

  function dedupeById(list) {
    const seen = new Set();
    return list.filter(c => (seen.has(c.id) ? false : (seen.add(c.id), true)))
               .sort((a, b) => a.name.localeCompare(b.name));
  }

  /* Nearest quarter hour, so the common case is already correct. */
  function defaultTime() {
    const d = new Date();
    const q = Math.round(d.getMinutes() / 15) * 15;
    const h = q === 60 ? (d.getHours() + 1) % 24 : d.getHours();
    const m = q === 60 ? 0 : q;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function renderSessionEditor(draft, clients, isEdit, dictated) {
    /* When the session came from dictation, show what was heard and what could
     * not be worked out, so the gaps are obvious before saving. */
    const banner = dictated ? `
      <div class="heardbox">
        <div class="heard-line">${esc(dictated.verb || 'Heard')}: “${esc(dictated.heard)}”</div>
        <div class="heard-sum">${esc(dictated.summary)}</div>
        ${(dictated.missing && dictated.missing.length)
          ? `<div class="heard-gap">Couldn't work out: ${esc(dictated.missing.join(', '))} — check below before saving.</div>` : ''}
        ${(dictated.ambiguous || []).map(a => `
          <div class="heard-gap">“${esc(a.phrase)}” matches ${a.options.length} members —
            ${esc(a.options.map(c => c.name).join(', '))}. Pick one below.</div>`).join('')}
        ${(dictated.unmatched && dictated.unmatched.length)
          ? `<div class="heard-gap">No member matched: ${esc(dictated.unmatched.join(', '))}</div>` : ''}
      </div>` : '';

    modal(`
      <div class="editor">
        <div class="editor-head">
          <h3>${isEdit ? 'Edit session' : dictated ? 'Check this session' : 'Add session'}</h3>
          <button class="btn btn-ghost" data-act="close">Close</button>
        </div>
        <div class="editor-body">
          ${banner}
          <div class="ed-block">
            <label class="ed-label">Date</label>
            <input type="date" id="ed-date" value="${esc(draft.date)}">
          </div>
          <div class="ed-block">
            <label class="ed-label">Class</label>
            <div id="ed-classes" class="classgrid"></div>
            <div id="ed-custom" class="hidden">
              <label class="ed-label">Minutes</label>
              <input type="number" id="ed-minutes" min="5" max="300" step="5" value="${esc(draft.customMinutes || 60)}">
            </div>
          </div>
          <div class="ed-block">
            <label class="ed-label">Start time <span id="ed-time-read" class="timeread"></span></label>
            <div class="timegrid">
              <div class="tg-col">
                <div class="tg-head">AM</div>
                <div class="tg-hours" data-half="am"></div>
              </div>
              <div class="tg-div"></div>
              <div class="tg-col">
                <div class="tg-head">PM</div>
                <div class="tg-hours" data-half="pm"></div>
              </div>
            </div>
            <div class="tg-mins" id="ed-mins"></div>
          </div>
          <div class="ed-block">
            <label class="ed-label">Who <span id="ed-seats" class="muted"></span></label>
            <div class="searchmic">
              <input type="search" id="ed-client-search" placeholder="Search members…" autocomplete="off"
                     value="${esc((dictated && dictated.searchSeed) || '')}">
              <button class="btn btn-mic${speechOk === false ? ' hidden' : ''}" id="ed-mic" type="button">🎤 Say a name</button>
            </div>
            <div id="ed-selected" class="chips"></div>
            <div id="ed-clients" class="picklist"></div>
          </div>
          <div class="ed-block">
            <label class="ed-label">Notes (optional)</label>
            <textarea id="ed-notes" rows="2">${esc(draft.notes || '')}</textarea>
          </div>
        </div>
        <div class="editor-foot">
          ${isEdit ? '<button class="btn btn-danger" data-act="delete">Delete</button>' : '<span></span>'}
          <button class="btn btn-primary btn-xl" data-act="save">Save session</button>
        </div>
      </div>`, {
      onOpen(card) {
        let search = (dictated && dictated.searchSeed) || '';

        const klass = () => CLASS_BY_CODE[draft.classCode] || CATALOGUE[0];

        function seatLimit() {
          const k = klass();
          return k.seats === 'many' ? Infinity : k.seats;
        }

        function paintClasses() {
          const groups = [...new Set(CATALOGUE.map(c => c.group))];
          $('#ed-classes', card).innerHTML = groups.map(g => `
            <div class="cg-group">
              <div class="cg-title">${esc(g)}</div>
              <div class="cg-btns">
                ${CATALOGUE.filter(c => c.group === g).map(c => `
                  <button type="button" class="cbtn${c.code === draft.classCode ? ' cbtn-on' : ''}"
                          data-code="${c.code}">
                    <b>${esc(c.label)}</b>
                    <span>${c.minutes ? c.minutes + ' min' : 'custom'}</span>
                  </button>`).join('')}
              </div>
            </div>`).join('');

          $$('#ed-classes .cbtn', card).forEach(b => {
            b.onclick = () => {
              draft.classCode = b.dataset.code;
              const lim = seatLimit();
              if (draft.attendees.length > lim) draft.attendees = draft.attendees.slice(0, lim);
              paintClasses(); paintCustom(); paintSeats(); paintSelected(); paintClients();
            };
          });
        }

        function paintCustom() {
          $('#ed-custom', card).classList.toggle('hidden', klass().minutes !== null);
        }

        function paintSeats() {
          const k = klass();
          const lim = seatLimit();
          $('#ed-seats', card).textContent =
            k.seats === 'many' ? '(group — add everyone who attended)'
            : k.seats === 2    ? `(2-on-1 — pick exactly 2, ${draft.attendees.length}/2 chosen)`
            :                    `(pick 1, ${draft.attendees.length}/1 chosen)`;
          $('#ed-seats', card).dataset.limit = lim;
        }

        function paintTime() {
          const [hh, mm] = draft.startTime.split(':');
          $('#ed-time-read', card).textContent = draft.startTime;

          const hours = (half) => (half === 'am' ? [0,1,2,3,4,5,6,7,8,9,10,11] : [12,13,14,15,16,17,18,19,20,21,22,23]);
          $$('.tg-hours', card).forEach(host => {
            const half = host.dataset.half;
            host.innerHTML = hours(half).map(h => {
              const v = String(h).padStart(2, '0');
              return `<button type="button" class="hbtn${v === hh ? ' hbtn-on' : ''}" data-h="${v}">${v}</button>`;
            }).join('');
          });

          $('#ed-mins', card).innerHTML = ['00','15','30','45'].map(m =>
            `<button type="button" class="mbtn${m === mm ? ' mbtn-on' : ''}" data-m="${m}">:${m}</button>`).join('');

          $$('.hbtn', card).forEach(b => b.onclick = () => {
            draft.startTime = b.dataset.h + ':' + draft.startTime.split(':')[1];
            paintTime();
          });
          $$('.mbtn', card).forEach(b => b.onclick = () => {
            draft.startTime = draft.startTime.split(':')[0] + ':' + b.dataset.m;
            paintTime();
          });
        }

        function paintSelected() {
          const byId = Object.fromEntries(clients.map(c => [c.id, c]));
          if (!draft.attendees.length) {
            $('#ed-selected', card).innerHTML = '<span class="muted">Nobody selected yet.</span>';
            return;
          }
          $('#ed-selected', card).innerHTML = draft.attendees.map(a => {
            const c = byId[a.clientId];
            const st = STATUS_BY_CODE[a.status] || STATUS_BY_CODE.attended;
            return `
              <div class="chip-att" data-id="${a.clientId}">
                <span class="chip-name">${esc(c ? c.name : '(removed)')}</span>
                <select class="chip-status" data-id="${a.clientId}">
                  ${STATUSES.map(s => `<option value="${s.code}"${s.code === st.code ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
                </select>
                <button type="button" class="chip-x" data-id="${a.clientId}" aria-label="Remove">×</button>
              </div>`;
          }).join('');

          $$('.chip-x', card).forEach(b => b.onclick = () => {
            draft.attendees = draft.attendees.filter(a => a.clientId !== b.dataset.id);
            paintSeats(); paintSelected(); paintClients();
          });
          $$('.chip-status', card).forEach(sel => sel.onchange = () => {
            const a = draft.attendees.find(x => x.clientId === sel.dataset.id);
            if (a) a.status = sel.value;
          });
        }

        function paintClients() {
          const chosen = new Set(draft.attendees.map(a => a.clientId));
          const q = Speech.normalise(search);
          const list = clients.filter(c =>
            !q || Speech.normalise(c.name).includes(q));

          if (!list.length) {
            $('#ed-clients', card).innerHTML =
              `<p class="empty">No match. <button type="button" class="linkbtn" id="ed-quickadd">Add "${esc(search)}" as a new client</button></p>`;
            const qa = $('#ed-quickadd', card);
            if (qa) qa.onclick = () => quickAdd(search);
            return;
          }

          const full = draft.attendees.length >= seatLimit();
          $('#ed-clients', card).innerHTML = list.map(c => `
            <button type="button" class="pick${chosen.has(c.id) ? ' pick-on' : ''}"
                    data-id="${c.id}" ${(!chosen.has(c.id) && full) ? 'disabled' : ''}>
              <span class="pick-name">${esc(c.name)}</span>
              ${c.notes ? `<span class="pick-note">${esc(c.notes)}</span>` : ''}
            </button>`).join('');

          $$('#ed-clients .pick', card).forEach(b => b.onclick = () => {
            const id = b.dataset.id;
            if (chosen.has(id)) {
              draft.attendees = draft.attendees.filter(a => a.clientId !== id);
            } else {
              if (draft.attendees.length >= seatLimit()) return;
              draft.attendees.push({ clientId: id, status: 'attended' });
            }
            paintSeats(); paintSelected(); paintClients();
          });
        }

        function quickAdd(name) {
          const clean = (name || '').trim();
          if (!clean) return;
          Store.addClient(clean).then(c => {
            clients.push(c);
            clients.sort((a, b) => a.name.localeCompare(b.name));
            if (draft.attendees.length < seatLimit()) {
              draft.attendees.push({ clientId: c.id, status: 'attended' });
            }
            search = '';
            $('#ed-client-search', card).value = '';
            paintSeats(); paintSelected(); paintClients();
            toast(`Added ${clean} to the roster.`);
          });
        }

        /* Voice: fills the search box and offers ranked matches for confirmation.
         * Never selects a client outright — spec §5. */
        $('#ed-mic', card).onclick = () => {
          const btn = $('#ed-mic', card);
          btn.disabled = true;
          btn.textContent = '🎤 Listening…';
          Speech.listen()
            .then(phrase => {
              const ranked = Speech.matchClients(phrase, clients);
              if (!ranked.length) {
                search = phrase;
                $('#ed-client-search', card).value = phrase;
                paintClients();
                toast(`Heard "${phrase}" — no roster match.`);
                return;
              }
              showVoiceMatches(phrase, ranked, (clientId) => {
                if (!draft.attendees.some(a => a.clientId === clientId) &&
                    draft.attendees.length < seatLimit()) {
                  draft.attendees.push({ clientId, status: 'attended' });
                }
                paintSeats(); paintSelected(); paintClients();
              }, () => quickAdd(phrase));
            })
            .catch(err => toast(err.message))
            .finally(() => { btn.disabled = false; btn.textContent = '🎤 Say a name'; });
        };

        $('#ed-client-search', card).oninput = (e) => { search = e.target.value; paintClients(); };
        $('#ed-date', card).onchange = (e) => { draft.date = e.target.value || draft.date; };
        $('#ed-minutes', card).oninput = (e) => { draft.customMinutes = Number(e.target.value) || 0; };
        $('#ed-notes', card).oninput = (e) => { draft.notes = e.target.value; };
        $('[data-act="close"]', card).onclick = closeModal;

        const delBtn = $('[data-act="delete"]', card);
        if (delBtn) delBtn.onclick = () => {
          confirmDialog('Delete this session?',
            'It will be removed from the log and from reports. You get 10 seconds to undo.',
            'Delete').then(ok => {
            if (!ok) return;
            Store.softDelete(draft.id).then(() => {
              closeModal(); renderLog();
              toast('Session deleted.', {
                actionLabel: 'Undo', ms: 10000,
                onAction: () => Store.undoDelete(draft.id).then(() => { renderLog(); toast('Restored.'); })
              });
            });
          });
        };

        $('[data-act="save"]', card).onclick = () => saveDraft();

        function saveDraft() {
          const k = klass();
          if (!draft.attendees.length) return toast('Pick at least one client.');
          if (k.seats === 2 && draft.attendees.length !== 2) return toast('A 2-on-1 needs exactly two clients.');
          if (k.minutes === null && !(Number(draft.customMinutes) > 0)) return toast('Enter the minutes for this session.');

          Store.findDuplicates(draft).then(dupes => {
            if (!dupes.length) return commit();
            /* Duplicate warning — spec §10.4. Warns, never blocks: two genuine
             * back-to-back entries at the same time do happen. */
            confirmDialog('Possible duplicate',
              `There is already a ${k.label} at ${draft.startTime} on ${draft.date} with one of these clients. Save anyway?`,
              'Save anyway').then(ok => { if (ok) commit(); });
          });
        }

        function commit() {
          Store.saveSession(draft).then(() => {
            closeModal();
            logDate = draft.date;
            renderLog();
            toast(isEdit ? 'Session updated.' : 'Session saved.');
          });
        }

        paintClasses(); paintCustom(); paintSeats(); paintTime(); paintSelected(); paintClients();
      }
    });
  }

  function showVoiceMatches(phrase, ranked, onPick, onAddNew) {
    const host = document.createElement('div');
    host.className = 'voicebox';
    host.innerHTML = `
      <div class="voicebox-inner">
        <p>Heard: <b>${esc(phrase)}</b></p>
        <div class="voice-opts">
          ${ranked.map(r => `<button type="button" class="btn btn-secondary" data-id="${r.client.id}">${esc(r.client.name)}</button>`).join('')}
        </div>
        <div class="voice-foot">
          <button type="button" class="btn btn-ghost" data-act="new">Add "${esc(phrase)}" as new</button>
          <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(host);
    const done = () => host.remove();
    $$('[data-id]', host).forEach(b => b.onclick = () => { onPick(b.dataset.id); done(); });
    $('[data-act="new"]', host).onclick = () => { onAddNew(); done(); };
    $('[data-act="cancel"]', host).onclick = done;
  }

  /* ══════════════════ CLIENTS ══════════════════ */

  function renderClients() {
    const q = Speech.normalise($('#client-search').value);
    const showArchived = $('#show-archived').checked;

    return Store.allClients().then(clients => {
      const active = clients.filter(c => !c.archived).length;
      $('#client-count').textContent =
        `${active} active member${active === 1 ? '' : 's'}` +
        (clients.length - active ? ` · ${clients.length - active} archived` : '');

      const list = clients
        .filter(c => showArchived ? true : !c.archived)
        .filter(c => !q || Speech.normalise(c.name).includes(q));

      if (!list.length) {
        /* A search with no hits is the moment someone realises the member is not
         * on the roster yet, so offer the add right there with the name filled in. */
        $('#client-list').innerHTML = q
          ? `<p class="empty">No member matches that.<br>
               <button class="linkbtn" id="cl-quickadd">Add "${esc($('#client-search').value.trim())}" as a new member</button></p>`
          : `<p class="empty">No members yet. Use <b>+ Add new member</b> above.</p>`;
        const qa = $('#cl-quickadd');
        if (qa) qa.onclick = () => openAddClient($('#client-search').value.trim());
        return;
      }

      $('#client-list').innerHTML = list.map(c => `
        <div class="row${c.archived ? ' row-dim' : ''}" data-id="${c.id}">
          <div class="row-main">
            <div class="row-title">${esc(c.name)}${c.archived ? ' <span class="tag">archived</span>' : ''}</div>
            ${c.notes ? `<div class="row-notes">${esc(c.notes)}</div>` : ''}
          </div>
          <div class="row-go">›</div>
        </div>`).join('');

      $$('#client-list .row').forEach(r =>
        r.onclick = () => openClientEditor(r.dataset.id));
    });
  }

  /* Voice search on the Clients screen. Speaking a name filters the roster; if
   * exactly one member matches well it opens them directly, which is the whole
   * point of speaking rather than typing. Never creates anything. */
  function voiceFindClient() {
    const btn = $('#client-mic');
    const restore = () => { btn.disabled = false; btn.textContent = '🎤 Say a name'; };
    btn.disabled = true;
    btn.textContent = '🎤 Listening…';

    Speech.listen()
      .then(raw => Store.allClients().then(clients => {
        const phrase = Speech.cleanName(raw);
        const pool = $('#show-archived').checked ? clients : clients.filter(c => !c.archived);
        const ranked = Speech.matchClients(phrase, pool);

        if (!ranked.length) {
          $('#client-search').value = phrase;
          renderClients();
          return toast(`Heard "${phrase}" — nobody on the roster matches.`, { ms: 6000 });
        }
        /* Open a member directly only on a strong match. A lone weak candidate
         * is still a guess, and opening the wrong person's record unasked is
         * worse than showing a short list. */
        if (ranked[0].score >= 70) {
          $('#client-search').value = ranked[0].client.name;
          return renderClients().then(() => openClientEditor(ranked[0].client.id));
        }
        showVoiceMatches(phrase, ranked,
          (clientId) => {
            const hit = pool.find(c => c.id === clientId);
            $('#client-search').value = hit ? hit.name : '';
            renderClients().then(() => openClientEditor(clientId));
          },
          () => openAddClient(phrase));
      }))
      .catch(err => toast(err.message))
      .finally(restore);
  }

  function openClientEditor(id) {
    DB.get('clients', id).then(c => {
      if (!c) return;
      modal(`
        <h3>Client</h3>
        <label class="field">Name
          <input id="cl-name" type="text" value="${esc(c.name)}">
        </label>
        <label class="field">Notes — shown when you select them
          <textarea id="cl-notes" rows="3" placeholder="Condition, contraindication, referral source…">${esc(c.notes || '')}</textarea>
        </label>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          ${c.archived
            ? '<button class="btn btn-secondary" data-act="restore">Restore</button>'
            : '<button class="btn btn-secondary" data-act="archive">Archive</button>'}
          <button class="btn btn-primary" data-act="save">Save</button>
        </div>
        <p class="muted small">Archiving hides someone from the pickers. Their past sessions stay in every report.</p>`, {
        onOpen(card) {
          $('[data-act="cancel"]', card).onclick = closeModal;
          $('[data-act="save"]', card).onclick = () => {
            const name = $('#cl-name', card).value.trim();
            if (!name) return toast('A member needs a name.');
            Store.updateClient(id, { name, notes: $('#cl-notes', card).value.trim() })
              .then(() => { closeModal(); renderClients(); toast('Member saved.'); });
          };
          const arch = $('[data-act="archive"]', card);
          if (arch) arch.onclick = () => Store.archiveClient(id)
            .then(() => { closeModal(); renderClients(); toast(`${c.name} archived.`); });
          const rest = $('[data-act="restore"]', card);
          if (rest) rest.onclick = () => Store.restoreClient(id)
            .then(() => { closeModal(); renderClients(); toast(`${c.name} restored.`); });
        }
      });
    });
  }

  function openAddClient(prefillName = '') {
    modal(`
      <h3>Add new member</h3>
      <label class="field">Name
        <input id="nc-name" type="text" autocomplete="off" value="${esc(prefillName)}">
      </label>
      <label class="field">Notes (optional)
        <textarea id="nc-notes" rows="3"></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="cancel">Cancel</button>
        <button class="btn btn-secondary" data-act="mic">🎤 Say the name</button>
        <button class="btn btn-primary" data-act="save">Add</button>
      </div>`, {
      onOpen(card) {
        $('[data-act="cancel"]', card).onclick = closeModal;
        $('[data-act="mic"]', card).onclick = () => {
          Speech.listen()
            .then(p => { const n = Speech.cleanName(p);
                         $('#nc-name', card).value = n;
                         toast(`Heard "${n}" — check the spelling before saving.`); })
            .catch(e => toast(e.message));
        };
        $('[data-act="save"]', card).onclick = () => {
          const name = $('#nc-name', card).value.trim();
          if (!name) return toast('A member needs a name.');
          Store.allClients().then(existing => {
            const clash = existing.find(c => Speech.normalise(c.name) === Speech.normalise(name));
            if (clash) return toast(`${clash.name} is already on the roster.`);
            Store.addClient(name, $('#nc-notes', card).value.trim())
              .then(() => { closeModal(); renderClients(); toast('Member added.'); });
          });
        };
      }
    });
  }

  /* Merge — the fix for near-duplicate names that voice entry will produce. */
  function openMerge() {
    Store.allClients().then(clients => {
      const opts = (sel) => clients.map(c =>
        `<option value="${c.id}">${esc(c.name)}${c.archived ? ' (archived)' : ''}</option>`).join('');
      modal(`
        <h3>Merge duplicate clients</h3>
        <p class="muted">Every session belonging to the duplicate is moved onto the client you keep. The duplicate is archived, not deleted.</p>
        <label class="field">Keep this client
          <select id="mg-keep">${opts()}</select>
        </label>
        <label class="field">Merge this one into it
          <select id="mg-drop">${opts()}</select>
        </label>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-primary" data-act="merge">Merge</button>
        </div>`, {
        onOpen(card) {
          $('[data-act="cancel"]', card).onclick = closeModal;
          $('[data-act="merge"]', card).onclick = () => {
            const keep = $('#mg-keep', card).value;
            const drop = $('#mg-drop', card).value;
            const keepName = clients.find(c => c.id === keep).name;
            const dropName = clients.find(c => c.id === drop).name;
            if (keep === drop) return toast('Pick two different clients.');
            confirmDialog('Merge clients?',
              `All sessions for ${dropName} will move to ${keepName}, and ${dropName} will be archived.`,
              'Merge').then(ok => {
              if (!ok) return;
              Store.mergeClients(keep, drop).then(n => {
                closeModal(); renderClients();
                toast(`Merged — ${n} session${n === 1 ? '' : 's'} moved to ${keepName}.`);
              }).catch(e => toast(e.message));
            });
          };
        }
      });
    });
  }

  /* ══════════════════ REPORT ══════════════════ */

  function renderReportScreen() {
    if (!$('#rep-from').value) {
      const p = Report.preset('this-month');
      $('#rep-from').value = p.from;
      $('#rep-to').value = p.to;
    }
    renderSendHistory();
  }

  function buildReport() {
    const from = $('#rep-from').value;
    const to = $('#rep-to').value;
    if (!from || !to) return toast('Pick both dates.');
    if (from > to) return toast('The "from" date is after the "to" date.');

    return Report.build(from, to).then(rep => {
      currentReport = rep;
      const g = rep.grand;

      if (!rep.rows.length) {
        $('#report-out').innerHTML = `<p class="empty">No sessions in that range.</p>`;
        $('#report-send').classList.add('hidden');
        return;
      }

      $('#report-out').innerHTML = `
        <div class="daytotal">
          <div class="dt-item"><b>${g.sessions}</b><span>sessions</span></div>
          <div class="dt-item"><b>${g.billableMinutes}</b><span>billable min</span></div>
          <div class="dt-item"><b>${(g.billableMinutes / 60).toFixed(1)}</b><span>billable hrs</span></div>
        </div>
        ${table('Totals by client', rep.byClient)}
        ${table('Totals by class', rep.byClass)}
        ${table('Totals by status', rep.byStatus)}
        <details class="detail">
          <summary>Every line (${rep.rows.length})</summary>
          <div class="tablewrap"><table class="tbl">
            <thead><tr><th>Date</th><th>Start</th><th>Client</th><th>Class</th><th>Min</th><th>Billable</th><th>Status</th></tr></thead>
            <tbody>${rep.rows.map(r => `
              <tr><td>${esc(r.date)}</td><td>${esc(r.startTime)}</td><td>${esc(r.client)}</td>
                  <td>${esc(r.classLabel)}</td><td>${r.minutes}</td><td>${r.billableMinutes}</td>
                  <td>${esc(r.status)}</td></tr>`).join('')}</tbody>
          </table></div>
        </details>`;

      $('#report-send').classList.remove('hidden');
    });
  }

  function table(title, rows) {
    const col = title.replace('Totals by ', '');
    return `
      <h3 class="section-title">${esc(title)}</h3>
      <div class="tablewrap"><table class="tbl">
        <thead><tr><th>${esc(col[0].toUpperCase() + col.slice(1))}</th><th>Sessions</th><th>Minutes</th><th>Billable</th></tr></thead>
        <tbody>${rows.map(t => `
          <tr><td>${esc(t.key)}</td><td>${t.lines}</td><td>${t.minutes}</td><td>${t.billableMinutes}</td></tr>`).join('')}</tbody>
      </table></div>`;
  }

  function renderSendHistory() {
    return Store.allSends().then(rows => {
      if (!rows.length) {
        $('#send-history').innerHTML = `<p class="empty">Nothing sent yet.</p>`;
        return;
      }
      $('#send-history').innerHTML = rows.slice(0, 20).map(r => {
        const cls = r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn';
        const label = r.status === 'sent' ? 'Sent'
                    : r.status === 'failed' ? 'FAILED'
                    : 'Handed to mail app';
        return `
          <div class="row">
            <div class="row-main">
              <div class="row-title"><span class="pill pill-${cls}">${label}</span>
                ${esc(r.range.from)} → ${esc(r.range.to)}</div>
              <div class="row-notes">${esc(new Date(r.at).toLocaleString())} · ${esc(r.detail || '')}</div>
            </div>
          </div>`;
      }).join('');
    });
  }

  /* ══════════════════ SETTINGS ══════════════════ */

  function renderSettings() {
    $('#set-to').value = Store.setting('accountingEmail') || '';
    $('#set-cc').value = Store.setting('ccEmail') || '';
    $('#set-endpoint').value = Store.setting('endpointUrl') || '';
    $('#set-token').value = Store.setting('endpointToken') || '';
    $('#set-remind').checked = !!Store.setting('remindWeekly');
    $('#pin-state').textContent = Store.setting('pinHash')
      ? 'A PIN is set. The app asks for it on launch.'
      : 'No PIN set. Anyone who picks up the tablet can open the app.';
    $('#app-info').textContent =
      `RSF Session Logger · ${Store.SEED_MEMBERS.length} members seeded at first run · storage: IndexedDB`;
  }

  function showDiagnostics() {
    const el = $('#diagnostics');
    el.classList.toggle('hidden');
    if (el.classList.contains('hidden')) return;
    Promise.all([Store.allClients(), Store.allSessions(), Store.allSends(), Speech.deviceSupported()])
      .then(([c, s, snd, ok]) => {
        speechOk = ok;
        el.textContent = [
          `Platform      : ${Native.isNative() ? 'Capacitor (native)' : 'browser'}`,
          `Voice layer   : ${Speech.activeLayer()}`,
          `File plugin   : ${Native.plugin('Filesystem') ? 'resolved via ' + Native.how('Filesystem') : 'NOT RESOLVED'}`,
          `Speech engine : ${speechOk === null ? 'checking…' : speechOk ? 'present' : 'NONE INSTALLED ON THIS DEVICE'}`,
          `Clients       : ${c.length} (${c.filter(x => x.archived).length} archived)`,
          `Sessions      : ${s.length}`,
          `Send records  : ${snd.length}`,
          `Endpoint set  : ${Store.setting('endpointUrl') ? 'yes' : 'no'}`,
          `Local date    : ${Store.localDate()}`,
          `Time zone     : ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
          `Online        : ${navigator.onLine}`
        ].join('\n');
      });
  }

  return {
    $, $$, esc, toast, hideToast, modal, closeModal, confirmDialog, showScreen,
    renderLog, renderClients, renderReportScreen, renderSettings, renderSendHistory,
    openSessionEditor, openAddClient, openMerge, buildReport, showDiagnostics,
    voiceFindClient, dictateSession, typeSession, voiceAvailable: () => Speech.available(),
    applySpeechAvailability,
    getLogDate: () => logDate,
    setLogDate: (d) => { logDate = d; },
    getReport: () => currentReport
  };
})();
