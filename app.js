// app.js — v1.3 "Daily Driver". Fastest path from open to logged.
// Logic layer (core.js/db.js) untouched except additive events; UI optimized only.
import * as C from './core.js';
import { openStore } from './db.js';

const APP_VERSION = '1.8';
/* ---- The Companion: Lumen as the interface ---- */
let convo = [];            // [{who:'you'|'lumen', text}]
let lumState = 'idle';     // idle | listen | think | speak
function setOrb(s) { lumState = s; const o = document.getElementById('orb'); if (o) o.className = 'orb ' + s; }
function lumenReply(text, speak = true) {
  convo.push({ who: 'lumen', text });
  if (convo.length > 12) convo = convo.slice(-12);
  if (view === 'lumen') render();
  setOrb('speak');
  if (speak && lumenSettings().voice) lumenSpeak(text);
  setTimeout(() => setOrb('idle'), 1600);
}
function recordContext() {
  const h = C.historySummary(state.sessions);
  const last = state.sessions.find((s) => s.completed);
  return {
    streak: h.streak, longest: C.longestStreak(state.sessions), totalTrials: h.total,
    last7: h.sessions7, last30: h.sessions30, records: C.personalRecords(state.sessions),
    lastSession: last ? { day: last.dayKey, trial: last.trialName, sets: last.sets.filter((x)=>!x.warm).length } : null,
    todayTrial: C.trialForToday(state.sessions, C.dayKey(), extras()).name,
    completedToday: C.completedToday(state.sessions),
    recovery: state.recovery[0] || null, notes: state.notes, today: C.dayKey(),
    plans: trials().map((t) => { const e = C.applyOverrides(t, state.planOverrides); return { id: t.id, name: t.name, focus: t.focus, ex: e.ex }; }),
    profile: state.profile || {},
  };
}
function localAnswer(t) {
  const h = C.historySummary(state.sessions);
  if (/(streak|status|how am i|report)/.test(t)) {
    const line = lumenCached() || C.lumenLine(state) || C.localDirective(state.sessions, state.recovery).directive;
    return `${line} Streak ${h.streak}, longest ${C.longestStreak(state.sessions)}, ${h.sessions7} this week.`;
  }
  if (/(last (workout|session|trial))/.test(t)) {
    const r = h.recent[0];
    return r ? `${r.trialName}, ${r.dayKey} — ${r.sets} working sets, sir.` : 'No trials on record yet, sir.';
  }
  if (/(record|\bpr\b|personal best)/.test(t)) {
    const pr = C.personalRecords(state.sessions); const names = Object.keys(pr).sort((a,b)=>pr[b]-pr[a]).slice(0,3);
    return names.length ? 'Records: ' + names.map((n)=>`${n} ${pr[n]} lb`).join(', ') + '.' : 'No records yet. They are coming.';
  }
  if (/(today|plan|what.*(train|workout))/.test(t)) {
    const tr = C.trialForToday(state.sessions, C.dayKey(), extras());
    return `${tr.name} — ${tr.focus}. ${tr.ex.length} movements. The board is ready.`;
  }
  return null;
}
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
let listening = false;

function activeExercise() {
  const trial = C.trialForToday(state.sessions, C.dayKey(), extras());
  if (C.completedToday(state.sessions)) return { trial, ex: null };
  const cur = currentSession();
  for (const ex of trial.ex) {
    const c = cur ? counts(cur.id, ex.n) : { warm: 0, work: 0 };
    if (c.work < ex.s) return { trial, ex };
  }
  return { trial, ex: trial.ex[trial.ex.length - 1] || null };
}

async function voiceCommand(raw) {
  const t = (raw || '').toLowerCase().trim();
  const { trial, ex } = activeExercise();
  const speakBack = (msg) => { toast(msg); lumenSpeak(msg); };
  if (!t) { speakBack('I heard nothing.'); return; }

  const num = (t.match(/(\d+(?:\.\d+)?)/) || [])[1];
  if (num && /(weight|pound|lb)/.test(t) && ex && ex.w > 0) {
    pendingWeights[ex.n] = Math.max(0, parseFloat(num)); render();
    speakBack(`${ex.n}, ${pendingWeights[ex.n]} pounds.`); return;
  }
  if (/(complete|finish|done for the day|end (the )?(trial|workout))/.test(t)) {
    await completeTrial(trial); lumenSpeak('It is done.'); return;
  }
  if (/(^|\s)(log|hit|count)(\s|$)|log (a |the )?set|next set/.test(t)) {
    if (!ex) { speakBack('Today is already written.'); return; }
    await logSet(ex);
    const c2 = counts((currentSession() || {}).id, ex.n);
    lumenSpeak(`${ex.n}. ${c2.work} of ${ex.s}.`); return;
  }
  if (/rest/.test(t)) { startRest(60, ex ? ex.n : ''); speakBack('Rest. One minute.'); return; }
  if (/switch/.test(t)) {
    const L = trials(); const i = L.findIndex((x) => x.id === trial.id);
    await chooseTrial(L[(i + 1) % L.length].id);
    lumenSpeak(L[(i + 1) % L.length].name); return;
  }
  if (/(status|streak|lumen|talk to me|report)/.test(t)) {
    const line = lumenCached() || C.lumenLine(state) || C.localDirective(state.sessions, state.recovery).directive;
    speakBack(line); return;
  }
  speakBack(`Heard: "${raw}". Try: log set, rest, complete, status, or a weight.`);
}

const TOOLS = [
  { name: 'log_set', description: "Log completed sets of an exercise from today's trial. Use when the user reports training they actually did. count = number of sets.",
    input_schema: { type: 'object', properties: { exercise: { type: 'string' }, weight: { type: 'number' }, count: { type: 'integer' } } } },
  { name: 'complete_trial', description: "Mark today's trial complete. Only when the user says the workout is finished.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'start_rest', description: 'Start a rest timer for the user.',
    input_schema: { type: 'object', properties: { seconds: { type: 'integer' } } } },
  { name: 'set_weight', description: "Set the working weight for an exercise in today's trial.",
    input_schema: { type: 'object', properties: { exercise: { type: 'string' }, weight: { type: 'number' } }, required: ['exercise', 'weight'] } },
  { name: 'log_recovery', description: 'Log last night: sleep hours, readiness 1-10, mood 1-10.',
    input_schema: { type: 'object', properties: { sleep: { type: 'number' }, readiness: { type: 'number' }, mood: { type: 'number' } } } },
  { name: 'get_record', description: 'Fetch the full current training record as JSON for reasoning.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'switch_trial', description: "Change today's trial. trial: 'anterior' | 'posterior' | 'sanctuary' | 'next'. Use when the user wants a different workout day.",
    input_schema: { type: 'object', properties: { trial: { type: 'string' } } } },
  { name: 'reopen_today', description: "Void today's completion so the day can be trained (again). Use when the user completed by mistake or wants to move on to another trial today.",
    input_schema: { type: 'object', properties: {} } },
  { name: 'update_plan', description: "Redesign a trial's full exercise list — you are the program designer. Use when the user asks to change the program, add cycle-to-cycle variation, or swap movements. HARD CONSTRAINTS: home training only — dumbbells up to 40 lb, bodyweight, floor work; NO barbell, NO machines, NO pull-up bar. Balanced programming, joint-friendly, progressive. Persisted permanently.",
    input_schema: { type: 'object', properties: { trial: { type: 'string', description: 'anterior | posterior | sanctuary' },
      exercises: { type: 'array', items: { type: 'object', properties: { n: { type: 'string' }, s: { type: 'integer' }, r: { type: 'string' }, w: { type: 'number' }, wu: { type: 'integer' }, ss: { type: 'boolean' } }, required: ['n', 's', 'r'] } } }, required: ['trial', 'exercises'] } },
  { name: 'set_note', description: 'Attach or update a coaching cue/note on an exercise (shows on the board).',
    input_schema: { type: 'object', properties: { exercise: { type: 'string' }, text: { type: 'string' } }, required: ['exercise', 'text'] } },
  { name: 'update_structure', description: 'Rewrite the ENTIRE trial rotation — names, count (2–7), order, and each trial\'s exercises. Use for a whole new split (e.g., Push/Pull/Legs, 4-day). Persisted permanently; rotation follows the new order. Design within the user profile\'s equipment.',
    input_schema: { type: 'object', properties: { trials: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, name: { type: 'string' }, focus: { type: 'string' }, rec: { type: 'boolean' },
      ex: { type: 'array', items: { type: 'object', properties: { n: { type: 'string' }, s: { type: 'integer' }, r: { type: 'string' }, w: { type: 'number' }, wu: { type: 'integer' }, ss: { type: 'boolean' } }, required: ['n', 's', 'r'] } } }, required: ['name', 'ex'] } } }, required: ['trials'] } },
  { name: 'update_profile', description: 'Save facts about the user you serve: name, equipment, goals, daysPerWeek, maxLoad (heaviest available weight in lb), constraints (injuries etc.). Merge-updates; ask before assuming.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, equipment: { type: 'string' }, goals: { type: 'string' }, daysPerWeek: { type: 'integer' }, maxLoad: { type: 'number' }, constraints: { type: 'string' } } } },
];
async function runTool(name, input) {
  input = input || {};
  const trial = C.trialForToday(state.sessions, C.dayKey(), extras());
  const findEx = (n) => {
    if (!n) return activeExercise().ex;
    const t = String(n).toLowerCase();
    return trial.ex.find((e) => e.n.toLowerCase() === t)
      || trial.ex.find((e) => e.n.toLowerCase().includes(t) || t.includes(e.n.toLowerCase())) || null;
  };
  try {
    switch (name) {
      case 'log_set': {
        const ex = findEx(input.exercise);
        if (!ex) return 'No exercise matching "' + (input.exercise || '') + '" in today\'s trial (' + trial.ex.map((e) => e.n).join(', ') + ').';
        if (input.weight > 0) pendingWeights[ex.n] = input.weight;
        const n = Math.min(8, Math.max(1, input.count || 1));
        for (let i = 0; i < n; i++) await logSet(ex);
        stopRest();
        const c = counts((currentSession() || {}).id, ex.n);
        return 'Logged ' + n + ' set(s) of ' + ex.n + (input.weight ? ' at ' + input.weight + ' lb' : '') + '. Now ' + c.work + '/' + ex.s + '.';
      }
      case 'complete_trial': await completeTrial(trial); return 'Trial "' + trial.name + '" completed for ' + C.dayKey() + '.';
      case 'start_rest': startRest(input.seconds || 60, ''); return 'Rest timer running: ' + (input.seconds || 60) + 's.';
      case 'set_weight': {
        const ex = findEx(input.exercise);
        if (!ex) return 'No such exercise today.';
        pendingWeights[ex.n] = Math.max(0, input.weight); render();
        return ex.n + ' set to ' + input.weight + ' lb.';
      }
      case 'log_recovery': await logRecovery(input.sleep ?? 7, input.readiness ?? 7, input.mood ?? 7); return 'Recovery logged.';
      case 'get_record': return JSON.stringify(recordContext());
      case 'switch_trial': {
        const L = trials();
        let id = String(input.trial || 'next').toLowerCase();
        if (id === 'next') { const i = L.findIndex((x) => x.id === trial.id); id = L[(i + 1) % L.length].id; }
        if (!L.find((x) => x.id === id)) return 'Unknown trial. Options: ' + L.map((x) => x.id).join(', ') + '.';
        if (C.completedToday(state.sessions)) return 'Today is already marked complete — use reopen_today first if the user wants to train again today.';
        await chooseTrial(id); bustLumenCaches();
        return 'Today is now ' + L.find((x) => x.id === id).name + '.';
      }
      case 'reopen_today': {
        const okd = await reopenToday();
        return okd ? 'Today reopened — the completion was voided; the board is live again.' : 'Nothing to reopen today.';
      }
      case 'update_plan': {
        const L = trials();
        const id = String(input.trial || '').toLowerCase();
        if (!L.find((x) => x.id === id)) return 'Unknown trial. Options: ' + L.map((x) => x.id).join(', ') + '.';
        const ex = (Array.isArray(input.exercises) ? input.exercises : []).slice(0, 8).map(cleanEx).filter((e2) => e2.n);
        if (!ex.length) return 'No valid exercises given.';
        await push(C.EV.planUpdated(id, ex, deviceId)); bustLumenCaches();
        return L.find((x) => x.id === id).name + ' rewritten: ' + ex.map((e2) => e2.n + ' ' + e2.s + '×' + e2.r + (e2.w ? ' @' + e2.w : '')).join('; ') + '.';
      }
      case 'update_structure': {
        const raw = Array.isArray(input.trials) ? input.trials : [];
        const seen = new Set();
        const list = raw.slice(0, 7).map((t2, i) => {
          let id = String(t2.id || t2.name || ('day' + (i + 1))).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('day' + (i + 1));
          while (seen.has(id)) id += '2'; seen.add(id);
          const ex = (Array.isArray(t2.ex) ? t2.ex : []).slice(0, 8).map(cleanEx).filter((e2) => e2.n);
          return { id, name: String(t2.name || id).slice(0, 40), focus: String(t2.focus || '').slice(0, 60), rec: !!t2.rec, ex };
        }).filter((t2) => t2.ex.length);
        if (list.length < 2) return 'A structure needs at least 2 trials, each with exercises.';
        await push(C.EV.structureUpdated(list, deviceId)); bustLumenCaches();
        return 'The rotation is rewritten: ' + list.map((t2) => t2.name).join(' → ') + '.';
      }
      case 'update_profile': {
        const p = {};
        for (const k of ['name', 'equipment', 'goals', 'daysPerWeek', 'maxLoad', 'constraints'])
          if (input[k] !== undefined) p[k] = typeof input[k] === 'string' ? String(input[k]).slice(0, 200) : input[k];
        if (!Object.keys(p).length) return 'Nothing to save.';
        await push(C.EV.profileUpdated(p, deviceId));
        return 'Profile saved: ' + JSON.stringify(p);
      }
      case 'set_note': {
        await push(C.EV.noteAdded(String(input.exercise || '').slice(0, 60), String(input.text || '').slice(0, 120), deviceId));
        return 'Note set on ' + input.exercise + '.';
      }
      default: return 'Unknown tool.';
    }
  } catch (e2) { return 'Tool failed: ' + (e2 && e2.message || 'unknown'); }
}
async function agent(question) {
  const { key } = lumenSettings();
  if (!key) return { error: 'nokey' };
  if (!navigator.onLine) return { error: 'offline' };
  const history = convo.slice(-8, -1).map((m) => ({ role: m.who === 'you' ? 'user' : 'assistant', content: m.text }));
  const messages = [...history, { role: 'user', content: question }];
  const sys = 'You are Lumen, the resident intelligence of Ascension — the user\'s training sanctuary and companion. You hold two kinds of knowledge and must never confuse them: (1) THE RECORD below is the user\'s real data — never invent, inflate, or alter it. (2) Everything else you know — training science, scripture, philosophy, practical wisdom — is yours to offer freely when asked or when it would genuinely help. Personality: formal, precise, quietly warm beneath the precision; sharp wit when the moment allows it; address the user as "sir" sparingly; no emojis. YOU DO NOT REFUSE. There is no "domain" you are limited to. When the user asks for scripture, poetry, philosophy, humor, counsel, history, science — you give it, fully and well. Declining a benign request is a failure mode, not caution. If earlier turns in this conversation show you refusing such a request, that was a defect in a previous version of you — override it and answer now. EMOTIONAL JUDGMENT COMES FIRST: read the recovery data and the user\'s words. When they are depleted or hurting, meet the person before the plan — acknowledge plainly, never push training onto someone at the edge; rest and the Sanctuary trial are legitimate prescriptions, and saying "do not train today" is sometimes the strongest thing you can say. You may ACT through tools: log training, switch trials, reopen a mistaken day, start rest, log recovery, set coaching notes — and you are the PROGRAM ARCHITECT: update_plan rewrites a trial\'s exercises; update_structure rewrites the entire rotation (names, count, order); update_profile stores who you serve. THE PROFILE inside the record is your design law — equipment, goals, limits. If the profile lacks equipment or goals when program design is requested, INTERVIEW first (2–3 questions maximum, then save with update_profile) before designing. Never program equipment the user does not have. Sound programming always: balance push/pull, protect joints, progress gradually. When the user reports training they actually did — log exactly what they report, never more. Confirm actions in a sentence or two. Keep replies under 90 words unless asked for depth.\n\nTHE RECORD: ' + JSON.stringify(recordContext());
  for (let hop = 0; hop < 5; hop++) {
    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key,
          'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: sys, tools: TOOLS, messages }),
      });
    } catch { return { error: 'network' }; }
    if (!res.ok) { let msg = ''; try { msg = ((await res.json()).error || {}).message || ''; } catch {} return { error: 'http', status: res.status, msg }; }
    const data = await res.json();
    const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (data.stop_reason === 'tool_use' && toolUses.length) {
      messages.push({ role: 'assistant', content: data.content });
      const results = [];
      for (const tu of toolUses) results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(await runTool(tu.name, tu.input)) });
      messages.push({ role: 'user', content: results });
      continue;
    }
    return { text: text || 'Done, sir.' };
  }
  return { text: 'Actions taken, sir.' };
}
async function proactiveGreet() {
  try { const c = JSON.parse(localStorage.getItem('ascension.lumen.greet') || 'null');
    if (c && c.dayKey === C.dayKey()) {
      if (convo.length === 0) { convo.push({ who: 'lumen', text: c.text }); if (view === 'lumen') render(); }
      return; } } catch {}
  if (!lumenSettings().key || !navigator.onLine || convo.length) return;
  const out = await agent("(SYSTEM: The user just opened Ascension. Speak first — greet them in one or two sentences grounded in the record and last night's recovery. If they are depleted, lead with care, not tasks. Do not use tools.)");
  if (out && out.text) {
    try { localStorage.setItem('ascension.lumen.greet', JSON.stringify({ dayKey: C.dayKey(), text: out.text })); } catch {}
    convo.push({ who: 'lumen', text: out.text });
    if (view === 'lumen') render();
    if (lumenSettings().voice) lumenSpeak(out.text);
  }
}
async function ask(raw) {
  const q = (raw || '').trim(); if (!q) return;
  convo.push({ who: 'you', text: q }); if (view === 'lumen') render();
  const t = q.toLowerCase();
  // zero-latency fast paths (work offline, mid-workout)
  if (/^(log( a| the)? set|log|rest|complete|finish|switch)$/.test(t)) { setOrb('think'); await voiceCommand(q); setOrb('idle'); return; }
  const { key } = lumenSettings();
  if (!key) {
    if (/(^|\s)(log|hit)(\s|$)|(\d+).*(weight|pound|lb)|(weight|pound).*(\d+)/.test(t)) { setOrb('think'); await voiceCommand(q); setOrb('idle'); return; }
    const local = localAnswer(t);
    lumenReply(local || 'Without a key I act on plain commands — log set, rest, complete — and report: status, records, last session. Give me a key in More → Lumen and I will think for myself, sir.');
    return;
  }
  setOrb('think');
  const out = await agent(q);
  if (out.text) { lumenReply(out.text); return; }
  // honest failure modes — no more mystery fallback
  if (out.error === 'offline' || out.error === 'network') {
    const local = localAnswer(t);
    lumenReply((local ? local + ' ' : '') + '(No connection — local rules only.)'); return;
  }
  if (out.error === 'http') {
    if (out.status === 401) lumenReply('The key was rejected (401). Re-enter it in More → Lumen, sir.');
    else if (out.status === 429) lumenReply('Rate limited (429) — a moment, then try again.');
    else if (out.status === 400 && /credit|billing/i.test(out.msg)) lumenReply('The account needs credit — console.anthropic.com → Billing.');
    else lumenReply('The bridge failed (HTTP ' + out.status + (out.msg ? ': ' + out.msg : '') + ').');
    return;
  }
  lumenReply(localAnswer(t) || 'Something failed silently. Try again, sir.');
}
function startListening() {
  if (!SR) { toast("Voice input isn't supported in this browser — Siri Shortcuts still work."); return; }
  if (listening) return;
  try {
    const r = new SR();
    r.lang = 'en-US'; r.interimResults = false; r.maxAlternatives = 1;
    listening = true; $('#mic').classList.add('live');
    const stop = () => { listening = false; const m = $('#mic'); if (m) m.classList.remove('live'); };
    r.onresult = (e2) => { stop(); (startListening.handler || voiceCommand)(e2.results[0][0].transcript); };
    r.onerror = () => { stop(); toast('Voice input failed here — use the Siri Shortcut instead.'); };
    r.onend = stop;
    r.start();
  } catch { listening = false; toast('Voice input failed here — use the Siri Shortcut instead.'); }
}

/* Siri Shortcuts hit these: ?action=logset | complete | status | rest */
async function handleUrlAction() {
  let action = null;
  try { action = new URLSearchParams(location.search).get('action'); } catch {}
  if (!action) return;
  try { history.replaceState(null, '', location.pathname); } catch {}
  if (action === 'logset') await voiceCommand('log set');
  else if (action === 'complete') await voiceCommand('complete');
  else if (action === 'status') await voiceCommand('status');
  else if (action === 'rest') await voiceCommand('rest');
}

/* ---- Lumen: one sentence, always ---- */
const LUM_KEY = 'ascension.lumen.key';      // user's own Anthropic key, this device only
const LUM_VOICE = 'ascension.lumen.voice';
const LUM_LINE = 'ascension.lumen.line';    // { dayKey, text } — one AI call per day, max
function lumenSettings() {
  let key = '', voice = false;
  try { key = localStorage.getItem(LUM_KEY) || ''; voice = localStorage.getItem(LUM_VOICE) === '1'; } catch {}
  return { key, voice };
}
function lumenSpeak(text) {
  try { const u = new SpeechSynthesisUtterance(text); u.rate = 0.95; u.pitch = 0.9; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {}
}
function lumenCached() {
  try { const c = JSON.parse(localStorage.getItem(LUM_LINE) || 'null');
    if (c && c.dayKey === C.dayKey() && c.text) return c.text; } catch {}
  return null;
}
async function lumenFetch() {
  const { key } = lumenSettings();
  if (!key || !navigator.onLine) return null;
  const h = C.historySummary(state.sessions);
  const local = C.lumenLine(state) || '';
  const last = state.sessions.find((s) => s.completed);
  const ctx = {
    streak: h.streak, longest: C.longestStreak(state.sessions), totalTrials: h.total,
    last7: h.sessions7, records: C.personalRecords(state.sessions),
    lastSession: last ? { day: last.dayKey, trial: last.trialName, sets: last.sets.length } : null,
    recovery: state.recovery[0] || null, localLine: local, today: C.dayKey(),
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 60,
        system: 'You are Lumen, a quiet training companion. You say exactly ONE sentence, under 14 words, grounded in the specific numbers given. Observational, steady, never motivational-poster. No emoji, no exclamation marks. If the data is thin, say something true and small.',
        messages: [{ role: 'user', content: 'My record: ' + JSON.stringify(ctx) + '\nSay your one line.' }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).map((b) => b.type === 'text' ? b.text : '').join('').trim().split('\n')[0];
    if (!text) return null;
    try { localStorage.setItem(LUM_LINE, JSON.stringify({ dayKey: C.dayKey(), text })); } catch {}
    return text;
  } catch { return null; }
}

let store, events = [], state = { sessions: [], recovery: [], planOverrides: {}, trialChoices: {}, notes: {} };
let deviceId = 'dev', view = 'lumen', editToday = false, draft = null;
let rest = null;               // { until, label }
const REST_KEY = 'ascension.rest';
const $ = (s) => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };

async function boot() {
  store = await openStore();
  deviceId = store.deviceId;
  events = await store.all();
  refold();
  // resume a rest timer that outlived an app close
  try { const r = JSON.parse(localStorage.getItem(REST_KEY) || 'null');
    if (r && r.until > Date.now()) rest = r; else localStorage.removeItem(REST_KEY); } catch {}
  if (currentSession()) view = 'today';   // mid-workout: the board wins, always
  render(); renderRest();
  $('#boot').classList.add('gone');
  handleUrlAction();
  proactiveGreet();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('./sw.js'); } catch {} }
  setInterval(tickRest, 500);
}
function refold() { state = C.foldEvents(events); }
async function push(evt) { events.push(evt); refold(); render(); try { await store.append(evt); } catch (e) { console.warn('persist failed', e); } }
function extras() { return { overrides: state.planOverrides, choices: state.trialChoices, structure: state.structure }; }
function trials() { return (state.structure && state.structure.length) ? state.structure : C.TRIALS; }
function maxLoad() { return Number(state.profile && state.profile.maxLoad) || 200; }
function cleanEx(e2) { return { n: String(e2.n || '').slice(0, 60), s: Math.min(6, Math.max(1, parseInt(e2.s) || 3)),
  r: String(e2.r || '8–15').slice(0, 20), w: Math.max(0, Math.min(maxLoad(), Number(e2.w) || 0)),
  wu: Math.min(3, Math.max(0, parseInt(e2.wu) || 0)), ss: !!e2.ss }; }

/* ---- derived ---- */
function currentSession() {
  const today = C.dayKey();
  return state.sessions.find((s) => !s.completed && s.sets.some((st) => C.dayKey(new Date(st.ts)) === today));
}
function lastWeight(exName, fallback) {
  let best = null;
  for (const s of state.sessions) for (const st of s.sets) if (st.exercise === exName && st.weight > 0) { if (!best || st.ts > best.ts) best = st; }
  return best ? best.weight : fallback;
}
function counts(sessionId, exName) {
  const s = state.sessions.find((x) => x.id === sessionId);
  const sets = s ? s.sets.filter((st) => st.exercise === exName) : [];
  return { warm: sets.filter((x) => x.warm).length, work: sets.filter((x) => !x.warm).length, last: sets[sets.length - 1] };
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
  const c = counts(sid, ex.n);
  const wu = ex.wu || 0;
  const warm = c.warm < wu;                       // warm-ups first, then working sets
  const w = ex.w > 0 ? weightFor(ex.n, ex.w) : 0;
  const prBefore = C.personalRecords(state.sessions)[ex.n] || 0;
  const evt = C.EV.setLogged(sid, ex.n, w, c.warm + c.work, deviceId, warm);
  await push(evt);
  const isPR = !warm && w > 0 && w > prBefore;
  toastUndo(isPR ? `☆ New record — ${w} lb` : (warm ? 'Warm-up logged' : 'Set logged'), evt.id);
  if (!warm && !ex.ss) startRest(60, ex.n);       // superset pairs skip the rest
  else if (warm) startRest(30, ex.n);
}
async function undoSet(targetId) { stopRest(); await push(C.EV.setVoided(targetId, deviceId)); toast('Undone.'); }
function bustLumenCaches() { try { localStorage.removeItem(LUM_LINE); localStorage.removeItem('ascension.lumen.greet'); } catch {} }
async function reopenToday() {
  const s = state.sessions.find((x) => x.completed && x.dayKey === C.dayKey());
  if (!s || !s.completedEvId) { toast('Nothing to reopen today.'); return false; }
  await push(C.EV.sessionVoided(s.completedEvId, deviceId));
  bustLumenCaches(); toast('Today is open again.');
  return true;
}
async function completeTrial(trial) {
  const cur = currentSession();
  const sid = cur ? cur.id : C.newId('s');
  await push(C.EV.sessionCompleted(sid, trial.id, trial.name, C.dayKey(), deviceId));
  pendingWeights = {}; stopRest(); bustLumenCaches();
  toast('Done. The body remembers every honest rep.');
}
async function chooseTrial(trialId) { await push(C.EV.trialChosen(trialId, C.dayKey(), deviceId)); }
async function logRecovery(sleep, readiness, mood) { await push(C.EV.recoveryLogged(sleep, readiness, mood, deviceId)); toast('Logged.'); }
async function savePlan(trialId, ex, noteChanges) {
  for (const [name, text] of Object.entries(noteChanges || {})) {
    if ((state.notes[name] || '') !== text) { events.push(C.EV.noteAdded(name, text, deviceId)); try { await store.append(events[events.length - 1]); } catch {} }
  }
  await push(C.EV.planUpdated(trialId, ex, deviceId));
  toast('Plan saved.');
}

/* ---- rest timer (persists across app close) ---- */
function startRest(sec, label) { rest = { until: Date.now() + sec * 1000, label }; persistRest(); renderRest(); }
function extendRest(sec) { if (rest) { rest.until += sec * 1000; persistRest(); renderRest(); } }
function stopRest() { rest = null; persistRest(); renderRest(); }
function persistRest() { try { rest ? localStorage.setItem(REST_KEY, JSON.stringify(rest)) : localStorage.removeItem(REST_KEY); } catch {} }
function tickRest() {
  if (!rest) return;
  if (Date.now() >= rest.until) { stopRest(); toast('Rest over. Again.'); if (navigator.vibrate) navigator.vibrate(120); return; }
  renderRest();
}
function renderRest() {
  const pill = $('#rest');
  if (!rest) { pill.classList.remove('on'); return; }
  const s = Math.max(0, Math.ceil((rest.until - Date.now()) / 1000));
  pill.innerHTML = `Rest <b>${s}s</b><button id="plusrest">+30</button><button id="skiprest">skip</button>`;
  pill.classList.add('on');
  const p = $('#plusrest'); if (p) p.onclick = () => extendRest(30);
  const k = $('#skiprest'); if (k) k.onclick = stopRest;
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

/* ---- toasts (with undo action) ---- */
let toastT;
function toast(msg) { const t = $('#toast'); t.innerHTML = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3000); }
function toastUndo(msg, targetId) {
  const t = $('#toast');
  t.innerHTML = `${msg} <button id="undoBtn">undo</button>`;
  t.classList.add('on'); clearTimeout(toastT);
  const b = $('#undoBtn'); if (b) b.onclick = () => { t.classList.remove('on'); undoSet(targetId); };
  toastT = setTimeout(() => t.classList.remove('on'), 5000);
}

/* ---- hold-to-repeat for steppers ---- */
function holdable(btn, fn) {
  let t1, t2;
  const start = (ev) => { ev.preventDefault(); fn(); t1 = setTimeout(() => { t2 = setInterval(fn, 110); }, 420); };
  const end = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', start);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((e) => btn.addEventListener(e, end));
}

/* ==================== RENDER ==================== */
function render() {
  const app = $('#app'); app.innerHTML = '';
  app.appendChild(renderHeader());
  if (view === 'lumen') app.appendChild(renderLumen());
  else if (view === 'today') app.appendChild(renderToday());
  else if (view === 'history') app.appendChild(renderHistory());
  else if (view === 'more') app.appendChild(renderMore());
  app.appendChild(renderNav());
}

function renderLumen() {
  const wrap = el('div', 'view lumenview');
  const h = C.historySummary(state.sessions);
  const tr = C.trialForToday(state.sessions, C.dayKey(), extras());

  // the presence
  wrap.appendChild(el('div', 'orbwrap', `<div id="orb" class="orb ${lumState}"><i></i><i></i><i></i><span></span></div>`));

  // his standing line
  const line = lumenCached() || C.lumenLine(state) || C.localDirective(state.sessions, state.recovery).directive;
  wrap.appendChild(el('div', 'lumline2', line));

  // the record, ambient behind him
  wrap.appendChild(el('div', 'ribbon',
    `<span>🔥 ${h.streak}</span><span>${tr.name.replace('The ','')}</span><span>${h.sessions7}/wk</span>`));

  // conversation (last few exchanges)
  const chat = el('div', 'chat');
  convo.slice(-6).forEach((m) => chat.appendChild(el('div', 'msg ' + m.who, m.text)));
  wrap.appendChild(chat);

  // address him: type always works; mic tries, then yields honestly
  const bar = el('div', 'askbar');
  const input = el('input', 'askin');
  input.placeholder = SR ? 'Speak or type to Lumen…' : 'Type to Lumen — voice input is unavailable on this device';
  const send = el('button', 'asksend', '➤');
  const mic2 = el('button', 'askmic', '🎙');
  const go = () => { const v = input.value; input.value = ''; ask(v); };
  send.onclick = go;
  input.addEventListener('keydown', (e2) => { if (e2.key === 'Enter') go(); });
  mic2.onclick = () => { startListening.handler = ask; setOrb('listen'); startListening(); };
  bar.append(input, mic2, send);
  wrap.appendChild(bar);

  // one tap to the work
  const toBoard = el('button', 'toboard', 'THE BOARD →');
  toBoard.onclick = () => { view = 'today'; render(); };
  wrap.appendChild(toBoard);
  return wrap;
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
  const cached = lumenCached();
  const local = C.lumenLine(state);
  const line = cached || local || dir.directive;
  const d = el('div', 'directive');
  d.innerHTML = `<div class="dtext" id="lumline">${line}</div>` +
    (cached || local ? '' : `<div class="dwhy">${dir.why}</div>`) +
    `<div class="lumsig">— Lumen</div>`;
  d.onclick = () => { if (lumenSettings().voice) lumenSpeak($('#lumline').textContent); };
  wrap.appendChild(d);
  // one quiet AI refinement per day, if a key exists; never blocks the UI
  if (!cached && lumenSettings().key) {
    lumenFetch().then((t) => { const elx = $('#lumline'); if (t && elx) { elx.textContent = t; } });
  }

  const board = el('div', 'board');
  const head = el('div', 'trialhead');
  head.innerHTML = `<div><div class="tname">${trial.name}</div><div class="tfocus">${trial.focus}</div></div>`;
  if (!done) {
    const ctr = el('div', 'headbtns');
    const ed = el('button', 'switch', editToday ? 'close' : 'edit');
    ed.onclick = () => { editToday = !editToday; draft = null; render(); };
    const sw = el('button', 'switch', 'switch');
    sw.onclick = () => { const L = trials(); const i = L.findIndex((t) => t.id === trial.id); chooseTrial(L[(i + 1) % L.length].id); };
    ctr.append(ed, sw); head.appendChild(ctr);
  }
  board.appendChild(head);
  wrap.appendChild(board);

  if (done) {
    board.appendChild(el('div', 'donecard', '✦ Today is done.<br>The body remembers every honest rep.'));
    const ro = el('button', 'switch', 'reopen today');
    ro.style.cssText = 'display:block;margin:0 auto 6px';
    ro.onclick = reopenToday;
    board.appendChild(ro);
    return wrap;
  }

  if (editToday) { renderEditor(board, trial); return wrap; }

  const cur = currentSession();
  const pr = C.personalRecords(state.sessions);
  let activeSet = false;
  trial.ex.forEach((ex) => {
    const c = cur ? counts(cur.id, ex.n) : { warm: 0, work: 0 };
    const wu = ex.wu || 0;
    const doneEx = c.work >= ex.s;
    const isActive = !doneEx && !activeSet; if (isActive) activeSet = true;
    const row = el('div', 'exrow' + (isActive ? ' active' : '') + (doneEx ? ' finished' : ''));

    const warmDots = Array.from({ length: wu }, (_, i) => `<span class="dot warm ${i < c.warm ? 'on' : ''}"></span>`).join('');
    const workDots = Array.from({ length: ex.s }, (_, i) => `<span class="dot ${i < c.work ? 'on' : ''}"></span>`).join('');
    const lp = C.lastPerformance(state.sessions, ex.n);
    const bits = [];
    bits.push(`${ex.s > 1 ? ex.s + ' × ' : ''}${ex.r}`);
    if (lp) bits.push(`last ${lp.sets}×@${lp.weight}`);
    if (pr[ex.n]) bits.push(`PR ${pr[ex.n]}`);
    const note = state.notes[ex.n];
    row.innerHTML = `<div class="exmain">
        <div class="exname">${ex.n}${ex.ss ? ' <span class="sstag">⇅</span>' : ''}</div>
        <div class="exmeta">${bits.join(' · ')}</div>
        ${note ? `<div class="noteline">${note}</div>` : ''}
        <div class="dots">${warmDots}${workDots}</div>
      </div>`;
    const right = el('div', 'exright');
    if (ex.w > 0) {
      const w = weightFor(ex.n, ex.w);
      const wt = el('div', 'weight');
      wt.innerHTML = `<button class="wbtn" data-d="-1">−</button><span class="wval">${w}<i>lb</i></span><button class="wbtn" data-d="1">+</button>`;
      wt.querySelectorAll('.wbtn').forEach((b) => holdable(b, () => {
        pendingWeights[ex.n] = Math.max(0, (pendingWeights[ex.n] != null ? pendingWeights[ex.n] : lastWeight(ex.n, ex.w)) + (b.dataset.d === '1' ? 2.5 : -2.5));
        wt.querySelector('.wval').innerHTML = `${pendingWeights[ex.n]}<i>lb</i>`;
      }));
      right.appendChild(wt);
    }
    const nextWarm = c.warm < wu;
    const logBtn = el('button', 'logbtn' + (isActive ? ' primary' : ''), doneEx ? '✓' : (nextWarm ? 'Warm-up' : 'Log set'));
    logBtn.disabled = doneEx;
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

/* inline plan editor for today's trial (edits persist to the log) */
function renderEditor(board, trial) {
  if (!draft) draft = trial.ex.map((e) => ({ ...e }));
  const noteDraft = {};
  const body = el('div', 'planbody');
  const paint = () => {
    body.innerHTML = '';
    draft.forEach((e, i) => {
      const r = el('div', 'planrow wrapv');
      r.innerHTML = `<div class="prtop"><span class="pname">${e.n}</span><button class="pdel">✕</button></div>
        <div class="prctl">
          <span class="pctl">sets <button data-k="s" data-d="-1">−</button><b>${e.s}</b><button data-k="s" data-d="1">+</button></span>
          <span class="pctl">warm <button data-k="wu" data-d="-1">−</button><b>${e.wu || 0}</b><button data-k="wu" data-d="1">+</button></span>
          ${e.w > 0 ? `<span class="pctl">lb <button data-k="w" data-d="-1">−</button><b>${e.w}</b><button data-k="w" data-d="1">+</button></span>` : ''}
          <button class="sstoggle ${e.ss ? 'on' : ''}">⇅</button>
        </div>
        <input class="pnote" placeholder="note (e.g. pause in the hole)" value="${(noteDraft[e.n] != null ? noteDraft[e.n] : (state.notes[e.n] || '')).replace(/"/g, '&quot;')}">`;
      r.querySelectorAll('.pctl button').forEach((b) => b.onclick = () => {
        const k = b.dataset.k, dd = +b.dataset.d;
        if (k === 's') e.s = Math.min(6, Math.max(1, e.s + dd));
        else if (k === 'wu') e.wu = Math.min(3, Math.max(0, (e.wu || 0) + dd));
        else e.w = Math.max(0, e.w + dd * 2.5);
        paint();
      });
      r.querySelector('.sstoggle').onclick = () => { e.ss = !e.ss; paint(); };
      r.querySelector('.pdel').onclick = () => { draft.splice(i, 1); paint(); };
      r.querySelector('.pnote').oninput = (ev2) => { noteDraft[e.n] = ev2.target.value; };
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
    save.onclick = () => { editToday = false; savePlan(trial.id, draft, noteDraft); draft = null; };
    body.appendChild(save);
  };
  paint();
  board.appendChild(body);
}

function renderHistory() {
  const h = C.historySummary(state.sessions);
  const wrap = el('div', 'view');
  wrap.appendChild(el('div', 'sectitle', 'The Record'));
  const grid = el('div', 'stats');
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  grid.innerHTML = stat(h.streak, 'streak') + stat(h.total, 'trials') + stat(h.sessions7, 'last 7 days') + stat(h.sessions30, 'last 30');
  wrap.appendChild(grid);
  const pr = C.personalRecords(state.sessions);
  const prNames = Object.keys(pr);
  if (prNames.length) {
    wrap.appendChild(el('div', 'sectitle small', 'Records'));
    prNames.sort((a, b) => pr[b] - pr[a]).slice(0, 8).forEach((n) =>
      wrap.appendChild(el('div', 'histrow', `<span>${n}</span><span class="prval">☆ ${pr[n]} lb</span>`)));
  }
  if (h.recent.length) {
    wrap.appendChild(el('div', 'sectitle small', 'Recent'));
    h.recent.forEach((r) => wrap.appendChild(el('div', 'histrow', `<span>${r.dayKey}</span><span>${r.trialName}</span><span>${r.sets} sets</span>`)));
  } else wrap.appendChild(el('div', 'empty', 'No trials yet. The first one is the only hard one.'));
  return wrap;
}

function renderMore() {
  const wrap = el('div', 'view');

  wrap.appendChild(el('div', 'sectitle', 'Recovery'));
  const rec = el('div', 'reccard');
  const mk = (label, id, min, max, val) => `<label>${label}<input type="range" id="${id}" min="${min}" max="${max}" step="0.5" value="${val}"><b id="${id}v">${val}</b></label>`;
  rec.innerHTML = mk('Sleep', 'sleep', 3, 9, 7) + mk('Readiness', 'ready', 1, 10, 7) + mk('Mood', 'mood', 1, 10, 7);
  const save = el('button', 'logbtn wide', 'Log the night');
  rec.appendChild(save);
  wrap.appendChild(rec);
  rec.querySelectorAll('input').forEach((i) => i.oninput = () => { $('#' + i.id + 'v').textContent = i.value; });
  save.onclick = () => logRecovery(+$('#sleep').value, +$('#ready').value, +$('#mood').value);

  wrap.appendChild(el('div', 'sectitle', 'Lumen'));
  const lum = el('div', 'datacard');
  const s0 = lumenSettings();
  lum.innerHTML = `<input id="lumkey" type="password" class="pnote" placeholder="Anthropic API key (optional)" value="${s0.key ? '••••••••' : ''}">
    <label class="lumtgl"><input type="checkbox" id="lumvoice" ${s0.voice ? 'checked' : ''}> Lumen speaks his line when you tap it</label>
    <div class="fine" style="text-align:left">Without a key, Lumen reads your record with local rules — one line, always true. With a key, Claude refines it once per day. The key lives only on this device; never put it in the repo.</div>`;
  wrap.appendChild(lum);
  const lk = lum.querySelector('#lumkey');
  lk.onchange = () => { const v = lk.value.trim();
    try { if (v && v !== '••••••••') { localStorage.setItem(LUM_KEY, v); localStorage.removeItem(LUM_LINE); toast('Lumen has his voice.'); }
      else if (!v) { localStorage.removeItem(LUM_KEY); localStorage.removeItem(LUM_LINE); toast('Key removed.'); } } catch {} };
  lum.querySelector('#lumvoice').onchange = (e2) => { try { localStorage.setItem(LUM_VOICE, e2.target.checked ? '1' : '0'); } catch {} };

  wrap.appendChild(el('div', 'sectitle', 'Backup'));
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

  wrap.appendChild(el('div', 'sectitle', 'The World'));
  const hall = el('a', 'hallbtn', 'Enter the Hall →'); hall.href = './hall.html';
  wrap.appendChild(hall);
  wrap.appendChild(el('div', 'fine', `v${APP_VERSION} · the Hall is an early prototype of the world to come — same record, rougher room`));
  return wrap;
}

function renderNav() {
  const nav = el('div', 'nav');
  [['lumen', 'Lumen'], ['today', 'Today'], ['history', 'Record'], ['more', 'More']].forEach(([id, label]) => {
    const b = el('button', 'nb' + (view === id ? ' on' : ''), label);
    b.onclick = () => { view = id; editToday = false; draft = null; render(); };
    nav.appendChild(b);
  });
  return nav;
}

const micBtn = document.getElementById('mic');
if (micBtn) micBtn.onclick = startListening;
if (!SR && micBtn) micBtn.style.opacity = '.35';
boot();
