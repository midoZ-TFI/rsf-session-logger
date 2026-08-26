# RSF Session Logger — app source

Plain HTML, CSS and JavaScript. No framework, no build step, no bundler.
Capacitor wraps this folder into an Android `.apk`; nothing here is compiled.

## Run it on a laptop

```bash
python3 -m http.server 8777 --directory www
```

Then open <http://127.0.0.1:8777>. Everything works except native voice, which
falls back to the browser Speech API — see `www/js/speech.js` for why that
distinction matters.

## Files

| File | What it does |
|---|---|
| `www/index.html` | All four screens, plus the lock and modal hosts |
| `www/css/app.css` | Everything visual. Brand navy `#12357e`, orange `#ee6b12` |
| `www/js/catalogue.js` | The 15 class types and the 4 attendance statuses |
| `www/js/db.js` | IndexedDB wrapper — open, get, put, export, import |
| `www/js/store.js` | Clients, sessions, settings, the date rules, the seed roster |
| `www/js/speech.js` | Three-layer voice input and fuzzy name matching |
| `www/js/report.js` | Report building, CSV, plain text, date presets |
| `www/js/sync.js` | Apps Script POST, mail-app fallback, backup and restore |
| `www/js/ui.js` | Screens, the session editor, the time grid, modals |
| `www/js/app.js` | Startup, PIN lock, event wiring |
| `apps-script/Code.gs` | The Google Apps Script — paste into script.google.com |

## Build the .apk

Push this folder to its own GitHub repo and use the **Build APK** workflow.
Full walkthrough in `../DOCUMENTS/TABLET-DEPLOYMENT.md`.

## Before changing anything

Two values are frozen because changing them erases every session on the tablet:
`appId` and `androidScheme` in `capacitor.config.json`. The reasoning is in
`../DECISIONS.md`.
