// app.js — the daily driver. Phase 1: fast, reliable, editable. No world systems.
import * as C from './core.js';
import { openStore } from './db.js';

const APP_VERSION = '1.2';
let store, events = [], state = { sessions: [], recovery: [], planOverrides: {}, trialChoices: {} };
let deviceId = 'dev', view = 'today', editTrialId = null;
let rest = null; // { until, label } — one global rest timer
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

async function boot() {
  store = await openStore();
  deviceId = store.deviceId;
  events = await store.all();
  refold(); render();
  $('#boot').classList.add('gone');
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('./sw.js'); } catch {} }
  setInterval(tickRest, 500);
}
function refold() { state = C.foldEvents(events); }
async function push(evt) { events.push(evt); refold(); render(); try { await store.append(evt); } catch (e) { console.warn('persist failed', e); } }
function extras() { return { overrides: state.planOverrides, choices: state.trialChoices }; }

/* ---- derived ---- */
function currentSession() {
  const today = C.dayKey();
  return state.sessions.find((s) => !s.completed && s.sets.some((st) => C.dayKey(new Date(st.ts)) === today));
}
function lastWeight(exName, fallback) {
  let best = null;
  for (const s of state.sessions) for (const st of s.sets) if (st.exercise === exName && st.weight != null) { if (!best || st.ts > best.ts) best = st; }
  return best ? best.weight : fallback;
}
function setsLogged(sessionId, exName) {
  const s = state.sessions.find((x) => x.id === sessionId);
  return s ? s.sets.filter((st) => st.exercise === exName).length : 0;
}
function recoveryToday() {
  const r = state.recovery[0];
  return r && C.dayKey(new Date(r.ts)) === C.dayKey();
}

/* ---- actions ---- */
let pendingWeights = {};
function weightFor(exName, def) { return pendingWeights[exName] != null ? pendingWeights[exName] : lastWeight(exName, def); }

async function logSet(ex) {
  const cur = currentSession();
  const sid = cur ? cur.id : C.newId('s');
  const idx = setsLogged(sid, ex.n);
  await push(C.EV.setLogged(sid, ex.n, ex.w > 0 ? weightFor(ex.n, ex.w) : 0, idx, deviceId));
  startRest(60, ex.n);
}
async function completeTrial(trial) {
  const cur = currentSession();
  const sid = cur ? cur.id : C.newId('s');
  await push(C.EV.sessionCompleted(sid, trial.id, trial.name, C.dayKey(), deviceId));
  pendingWeights = {}; stopRest();
  toast('Done. The body remembers every honest rep.');
}
async function chooseTrial(trialId) { await push(C.EV.trialChosen(trialId, C.dayKey(), deviceId)); }
async function logRecovery(sleep, readiness, mood) { await push(C.EV.recoveryLogged(sleep, readiness, mood, deviceId)); toast('Logged.'); }
async function savePlan(trialId, ex) { await push(C.EV.planUpdated(trialId, ex, deviceId)); toast('Plan saved.'); }

/* ---- rest timer ---- */
function startRest(sec, label) { rest = { until: Date.now() + sec * 1000, label }; renderRest(); }
function stopRest() { rest = null; renderRest(); }
function tickRest() {
  if (!rest) return;
  if (Date.now() >= rest.until) { rest = null; renderRest(); toast('Rest over. Again.'); if (navigator.vibrate) navigator.vibrate(120); return; }
  renderRest();
}
function renderRest() {
  const pill = $('#rest');
  if (!rest) { pill.classList.remove('on'); return; }
  const s = Math.max(0, Math.ceil((rest.until - Date.now()) / 1000));
  pill.innerHTML = `Rest <b>${s}s</b><button id="skiprest">skip</button>`;
  pill.classList.add('on');
  const btn = $('#skiprest'); if (btn) btn.onclick = stopRest;
}

/* ---- backup ---- */
function exportBackup() {
  const blob = new Blob([C.makeBackup(events, deviceId)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = `ascension-backup-${C.dayKey()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function importBackup(file) {
  try {
    const incoming = C.readBackup(await file.text());
    const ids = new Set(events.map((e) => e.id));
    const add = incoming.filter((e) => !ids.has(e.id));
    events = events.concat(add); refold();
    try { await store.import(add); } catch {}
    render(); toast(`Restored ${add.length} events.`);
  } catch { toast('That file is not an Ascension backup.'); }
}

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3000); }

/* ==================== RENDER ==================== */
function render() {
  const app = $('#app'); app.innerHTML = '';
  app.appendChild(renderHeader());
  if (view === 'today') app.appendChild(renderToday());
  else if (view === 'history') app.appendChild(renderHistory());
  else if (view === 'more') app.appendChild(renderMore());
  app.appendChild(renderNav());
}
function renderHeader() {
  const h = C.historySummary(state.sessions);
  const wrap = el('div', 'header');
  const hr = new Date().getHours();
  const greet = hr < 5 ? 'The hall is quiet.' : hr < 12 ? 'Morning. The fire is lit.' : hr < 18 ? 'The light is still good.' : 'Evening. The forge still burns.';
  wrap.appendChild(el('div', null, `<div class="brand">ASCENSION</div><div class="greet">${greet}</div>`));
  wrap.appendChild(el('div', 'streak', `<span class="fl">🔥</span><b>${h.streak}</b><span>day${h.streak === 1 ? '' : 's'}</span>`));
  return wrap;
}

function renderToday() {
  const wrap = el('div', 'view');
  const trial = C.trialForToday(state.sessions, C.dayKey(), extras());
  const done = C.completedToday(state.sessions);

  // 5-second morning ritual, only until it's done
  if (!recoveryToday()) {
    const rec = el('div', 'quickrec');
    rec.innerHTML = `<div class="qlabel">Last night — 5 seconds</div>
      <div class="qrow"><span>Sleep</span><input type="range" id="qs" min="3" max="9" step="0.5" value="7"><b id="qsv">7</b></div>
      <div class="qrow"><span>Readiness</span><input type="range" id="qr" min="1" max="10" step="1" value="7"><b id="qrv">7</b></div>`;
    const save = el('button', 'qsave', 'Log it');
    rec.appendChild(save);
    wrap.appendChild(rec);
    rec.querySelectorAll('input').forEach((i) => i.oninput = () => { $('#' + i.id + 'v').textContent = i.value; });
    save.onclick = () => logRecovery(+$('#qs').value, +$('#qr').value, 7);
  }

  const dir = C.localDirective(state.sessions, state.recovery);
  const d = el('div', 'directive');
  d.innerHTML = `<div class="dtext">${dir.directive}</div><div class="dwhy">${dir.why}</div>`;
  wrap.appendChild(d);

  const board = el('div', 'board');
  const head = el('div', 'trialhead');
  head.innerHTML = `<div><div class="tname">${trial.name}</div><div class="tfocus">${trial.focus}</div></div>`;
  if (!done) {
    const sw = el('button', 'switch', 'switch');
    sw.onclick = () => {
      const i = C.TRIALS.findIndex((t) => t.id === trial.id);
      chooseTrial(C.TRIALS[(i + 1) % C.TRIALS.length].id);
    };
    head.appendChild(sw);
  }
  board.appendChild(head);
  wrap.appendChild(board);

  if (done) { board.appendChild(el('div', 'donecard', '✦ Today is done.<br>The body remembers every honest rep.')); return wrap; }

  const cur = currentSession();
  trial.ex.forEach((ex) => {
    const row = el('div', 'exrow');
    const logged = cur ? setsLogged(cur.id, ex.n) : 0;
    const dots = Array.from({ length: ex.s }, (_, i) => `<span class="dot ${i < logged ? 'on' : ''}"></span>`).join('');
    row.innerHTML = `<div class="exmain"><div class="exname">${ex.n}</div><div class="exmeta">${ex.s > 1 ? ex.s + ' × ' : ''}${ex.r}</div><div class="dots">${dots}</div></div>`;
    const right = el('div', 'exright');
    if (ex.w > 0) {
      const w = weightFor(ex.n, ex.w);
      const wt = el('div', 'weight');
      wt.innerHTML = `<button class="wbtn" data-d="-1">−</button><span class="wval">${w}<i>lb</i></span><button class="wbtn" data-d="1">+</button>`;
      wt.querySelectorAll('.wbtn').forEach((b) => b.onclick = () => { pendingWeights[ex.n] = Math.max(0, weightFor(ex.n, ex.w) + (b.dataset.d === '1' ? 2.5 : -2.5)); render(); });
      right.appendChild(wt);
    }
    const logBtn = el('button', 'logbtn', logged >= ex.s ? '✓' : 'Log set');
    logBtn.disabled = logged >= ex.s;
    logBtn.onclick = () => logSet(ex);
    right.appendChild(logBtn);
    row.appendChild(right);
    board.appendChild(row);
  });

  const complete = el('button', 'complete', trial.rec ? 'COMPLETE RECOVERY' : 'COMPLETE THE TRIAL');
  complete.onclick = () => completeTrial(trial);
  board.appendChild(complete);
  return wrap;
}

function renderHistory() {
  const h = C.historySummary(state.sessions);
  const wrap = el('div', 'view');
  wrap.appendChild(el('div', 'sectitle', 'The Record'));
  const grid = el('div', 'stats');
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  grid.innerHTML = stat(h.streak, 'streak') + stat(h.total, 'trials') + stat(h.sessions7, 'last 7 days') + stat(h.sessions30, 'last 30');
  wrap.appendChild(grid);
  if (h.recent.length) {
    wrap.appendChild(el('div', 'sectitle small', 'Recent'));
    h.recent.forEach((r) => wrap.appendChild(el('div', 'histrow', `<span>${r.dayKey}</span><span>${r.trialName}</span><span>${r.sets} sets</span>`)));
  } else wrap.appendChild(el('div', 'empty', 'No trials yet. The first one is the only hard one.'));
  return wrap;
}

function renderMore() {
  const wrap = el('div', 'view');

  wrap.appendChild(el('div', 'sectitle', 'Edit the Plan'));
  C.TRIALS.forEach((t) => {
    const cur = C.applyOverrides(t, state.planOverrides);
    const card = el('div', 'plancard');
    const head = el('div', 'planhead', `<span>${t.name}</span><b>${editTrialId === t.id ? '▾' : '▸'}</b>`);
    head.onclick = () => { editTrialId = editTrialId === t.id ? null : t.id; render(); };
    card.appendChild(head);
    if (editTrialId === t.id) {
      const draft = cur.ex.map((e) => ({ ...e }));
      const body = el('div', 'planbody');
      const paint = () => {
        body.innerHTML = '';
        draft.forEach((e, i) => {
          const r = el('div', 'planrow');
          r.innerHTML = `<span class="pname">${e.n}</span>
            <span class="pctl">sets <button data-k="s" data-d="-1">−</button><b>${e.s}</b><button data-k="s" data-d="1">+</button></span>
            ${e.w > 0 ? `<span class="pctl">lb <button data-k="w" data-d="-1">−</button><b>${e.w}</b><button data-k="w" data-d="1">+</button></span>` : ''}
            <button class="pdel">✕</button>`;
          r.querySelectorAll('.pctl button').forEach((b) => b.onclick = () => {
            const k = b.dataset.k, d = +b.dataset.d;
            if (k === 's') e.s = Math.min(6, Math.max(1, e.s + d));
            else e.w = Math.max(0, e.w + d * 2.5);
            paint();
          });
          r.querySelector('.pdel').onclick = () => { draft.splice(i, 1); paint(); };
          body.appendChild(r);
        });
        const addrow = el('div', 'planadd');
        addrow.innerHTML = `<input id="newex" placeholder="Add exercise…"><button id="addex">+</button>`;
        body.appendChild(addrow);
        addrow.querySelector('#addex').onclick = () => {
          const v = addrow.querySelector('#newex').value.trim();
          if (v) { draft.push({ n: v, s: 3, r: '8–15', w: 20 }); paint(); }
        };
        const save = el('button', 'logbtn wide', 'Save plan');
        save.onclick = () => savePlan(t.id, draft);
        body.appendChild(save);
      };
      paint();
      card.appendChild(body);
    }
    wrap.appendChild(card);
  });

  wrap.appendChild(el('div', 'sectitle', 'Last Night (full)'));
  const rec = el('div', 'reccard');
  const mk = (label, id, min, max, val) => `<label>${label}<input type="range" id="${id}" min="${min}" max="${max}" step="0.5" value="${val}"><b id="${id}v">${val}</b></label>`;
  rec.innerHTML = mk('Sleep', 'sleep', 3, 9, 7) + mk('Readiness', 'ready', 1, 10, 7) + mk('Mood', 'mood', 1, 10, 7);
  const save = el('button', 'logbtn wide', 'Log the night');
  rec.appendChild(save);
  wrap.appendChild(rec);
  rec.querySelectorAll('input').forEach((i) => i.oninput = () => { $('#' + i.id + 'v').textContent = i.value; });
  save.onclick = () => logRecovery(+$('#sleep').value, +$('#ready').value, +$('#mood').value);

  wrap.appendChild(el('div', 'sectitle', 'Your Data'));
  const backend = store ? store.backend : '—';
  const dc = el('div', 'datacard');
  dc.innerHTML = backend === 'memory'
    ? `<div class="warn">⚠ Memory-only storage here — data won't survive a reload. Open the installed app (https) for durable storage.</div>`
    : `<div class="ok">Stored durably (${backend}). ${events.length} events.</div>`;
  const exp = el('button', 'logbtn', 'Export backup'); exp.onclick = exportBackup;
  const imp = el('button', 'logbtn', 'Import backup');
  const file = el('input'); file.type = 'file'; file.accept = 'application/json'; file.style.display = 'none';
  file.onchange = () => file.files[0] && importBackup(file.files[0]);
  imp.onclick = () => file.click();
  const btns = el('div', 'databtns'); btns.append(exp, imp, file);
  dc.appendChild(btns); wrap.appendChild(dc);

  const hall = el('a', 'hallbtn', 'Enter the Hall →'); hall.href = './hall.html';
  wrap.appendChild(el('div', 'sectitle', 'The World'));
  wrap.appendChild(hall);
  wrap.appendChild(el('div', 'fine', `v${APP_VERSION} · the Hall is an early prototype of the world to come — same record, rougher room`));
  return wrap;
}

function renderNav() {
  const nav = el('div', 'nav');
  [['today', 'Today'], ['history', 'Record'], ['more', 'More']].forEach(([id, label]) => {
    const b = el('button', 'nb' + (view === id ? ' on' : ''), label);
    b.onclick = () => { view = id; editTrialId = null; render(); };
    nav.appendChild(b);
  });
  return nav;
}

boot();
