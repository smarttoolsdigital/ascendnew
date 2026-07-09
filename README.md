# Ascension — the product foundation

This is the daily driver: fast to open, reliable to log, works offline, installs to
your home screen, and cannot silently lose your data. The living world (the Hall)
sits on top of this later — it reads the same record. Reliability first, world second.

## What's here
- `index.html` / `app.js` — the daily driver (Today · Record · More). Pure DOM, opens instantly.
- `core.js` — the domain logic (plan, streaks, history, twin, directive). Pure & tested.
- `db.js` — durable storage: **IndexedDB → localStorage → in-memory**, one API, auto-migrating.
- `sw.js` + `manifest.webmanifest` + `icons/` — offline + home-screen install (PWA).
- `core.test.mjs` — the proof. `node core.test.mjs` → 23 passing.

## Why it stops losing data on mobile
The old builds leaned on `localStorage` inside an in-app webview, which is sandboxed —
that's why data vanished. Two fixes: (1) storage now falls back through IndexedDB →
localStorage → memory and tells you which it got; (2) as an **installed PWA on its own
https origin**, storage is durable and private to the app. The substrate is the fix.

## Run it / install it
It's a PWA, so it must be **served over https** (or localhost) — not opened as a file.

Local check:
```
npx serve .          # open the printed http://localhost URL
```
Ship it (free, 2 minutes): push this folder to a **GitHub Pages** repo. Then on your phone
open the Pages URL → Share → **Add to Home Screen**. It now launches full-screen, works
offline, and persists.

## The architecture (why it's sync-ready)
The source of truth is an **append-only event log** (`SET_LOGGED`, `SESSION_COMPLETED`,
`RECOVERY_LOGGED`), each event stamped with time + device id. All state — streaks,
history, today's trial — is *derived* by folding the log. Folding is order-independent
and dedupes by id, so syncing two devices later is just "concatenate both logs and fold."
No backend needed today; when you want one, it reconciles logs — nothing in the UI changes.

Data safety is built in: **More → Export backup** writes the whole log to a JSON file;
Import merges one back (dedup-safe). Your month of work can't evaporate.

## Wiring the Hall in (next step, not this one)
The Hall's in-memory `S` object becomes a thin adapter over `db.js`: on a logged set it
calls `push(EV.setLogged(...))`; on finish, `EV.sessionCompleted(...)`. It then renders
from `core.foldEvents()` like this app does. Same record, two windows onto it.

## Honest status
- **Verified by running:** all of `core.js` (23 tests: streaks incl. edge cases, log
  folding, dedupe, history, offline directive, backup round-trip); syntax of every file.
- **Needs your device to confirm:** IndexedDB persistence, service-worker offline, and
  the install prompt — these are browser behaviors I can't execute here. First on-device
  serve is the real test. If `More` shows "memory-only," you opened it as a file or in a
  sandbox — serve it over https and it'll switch to durable.

## The rule from here
Before adding anything: *would this make someone glad they opened the app today?* If it's
another panel of buttons, it waits. If it makes the place worth returning to, it's in.
