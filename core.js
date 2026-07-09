// core.js — Ascension domain logic. Pure. No DOM, no storage, no browser.
// This is the part that must be correct, so it's the part we can test in Node.
// The event log is the source of truth; everything else is derived from it.
// That makes it sync-ready: a future backend just reconciles event logs.

export const SCHEMA_VERSION = 1;

/* ---------------- the training plan (rotates) ---------------- */
export const TRIALS = [
  { id: 'anterior', name: 'The Anterior Trial', focus: 'Shoulders · Quads · Chest', ex: [
    { n: 'Goblet Squat', s: 5, r: '10–20', w: 25 },
    { n: 'DB Floor Press', s: 5, r: '8–15', w: 30 },
    { n: 'Standing One-Arm Press', s: 5, r: '8–12', w: 20 },
    { n: 'Lateral Raise', s: 4, r: '12–25', w: 15 },
    { n: 'Weighted Sit-ups', s: 2, r: '12–20', w: 20 },
  ]},
  { id: 'posterior', name: 'The Posterior Trial', focus: 'Hamstrings · Back · Glutes', ex: [
    { n: 'Romanian Deadlift', s: 4, r: '10–20', w: 35 },
    { n: 'Bent-Over Row', s: 4, r: '10–20', w: 35 },
    { n: 'Rear Delt Fly', s: 3, r: '12–25', w: 10 },
    { n: 'Glute Bridge', s: 3, r: '12–25', w: 35 },
    { n: 'Biceps Burnout', s: 3, r: 'to failure', w: 25 },
  ]},
  { id: 'sanctuary', name: 'The Sanctuary', focus: 'Mobility · Recovery', rec: true, ex: [
    { n: 'Mobility Flow', s: 1, r: '10–20 min', w: 0 },
    { n: 'Hip & Glute Reset', s: 1, r: 'flow', w: 0 },
    { n: 'Incline Walk', s: 1, r: '20–40 min', w: 0 },
  ]},
];

/* ---------------- time helpers (local day) ---------------- */
export function dayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dayKey(dt);
}

/* ---------------- id ---------------- */
let _seq = 0;
export function newId(prefix = 'e') {
  return `${prefix}_${Date.now().toString(36)}_${(_seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/* ---------------- event constructors (append-only log) ---------------- */
export const EV = {
  setLogged: (sessionId, exercise, weight, setIndex, deviceId) =>
    ({ id: newId(), ts: Date.now(), deviceId, v: SCHEMA_VERSION, type: 'SET_LOGGED',
       payload: { sessionId, exercise, weight, setIndex } }),
  sessionCompleted: (sessionId, trialId, trialName, key, deviceId) =>
    ({ id: newId(), ts: Date.now(), deviceId, v: SCHEMA_VERSION, type: 'SESSION_COMPLETED',
       payload: { sessionId, trialId, trialName, dayKey: key } }),
  recoveryLogged: (sleep, readiness, mood, deviceId) =>
    ({ id: newId(), ts: Date.now(), deviceId, v: SCHEMA_VERSION, type: 'RECOVERY_LOGGED',
       payload: { sleep, readiness, mood } }),
  planUpdated: (trialId, ex, deviceId) =>
    ({ id: newId(), ts: Date.now(), deviceId, v: SCHEMA_VERSION, type: 'PLAN_UPDATED',
       payload: { trialId, ex } }),
  trialChosen: (trialId, key, deviceId) =>
    ({ id: newId(), ts: Date.now(), deviceId, v: SCHEMA_VERSION, type: 'TRIAL_CHOSEN',
       payload: { trialId, dayKey: key } }),
};

/* ---------------- fold the log into state ----------------
   Order-independent: we sort by ts, then dedupe by event id (so merging two
   devices' logs is just concatenate + fold). This is the sync contract. */
export function foldEvents(events) {
  const seen = new Set();
  const sorted = [...events]
    .filter((e) => e && e.id && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.ts - b.ts);

  const sessionsById = new Map();
  const recovery = [];
  const planOverrides = {};   // trialId -> ex[]      (latest wins; merge-safe)
  const trialChoices = {};    // dayKey  -> trialId   (latest wins)

  for (const e of sorted) {
    const p = e.payload || {};
    if (e.type === 'SET_LOGGED') {
      const s = sessionsById.get(p.sessionId) || { id: p.sessionId, sets: [], completed: false };
      s.sets.push({ exercise: p.exercise, weight: p.weight, setIndex: p.setIndex, ts: e.ts });
      sessionsById.set(p.sessionId, s);
    } else if (e.type === 'SESSION_COMPLETED') {
      const s = sessionsById.get(p.sessionId) || { id: p.sessionId, sets: [] };
      s.completed = true; s.trialId = p.trialId; s.trialName = p.trialName;
      s.dayKey = p.dayKey; s.completedTs = e.ts;
      sessionsById.set(p.sessionId, s);
    } else if (e.type === 'RECOVERY_LOGGED') {
      recovery.unshift({ sleep: p.sleep, readiness: p.readiness, mood: p.mood, ts: e.ts });
    } else if (e.type === 'PLAN_UPDATED') {
      if (p.trialId && Array.isArray(p.ex)) planOverrides[p.trialId] = p.ex;
    } else if (e.type === 'TRIAL_CHOSEN') {
      if (p.trialId && p.dayKey) trialChoices[p.dayKey] = p.trialId;
    }
  }
  const sessions = [...sessionsById.values()].sort((a, b) => (b.completedTs || 0) - (a.completedTs || 0));
  return { sessions, recovery, planOverrides, trialChoices };
}

/* ---------------- streak ----------------
   A streak is consecutive days with a completed session. It stays "alive" today
   until the day ends: if today isn't done yet but yesterday was, the streak still
   counts (from yesterday). A gap of a full day breaks it. */
export function computeStreak(sessions, today = dayKey()) {
  const days = new Set(sessions.filter((s) => s.completed && s.dayKey).map((s) => s.dayKey));
  if (days.size === 0) return 0;
  let anchor = days.has(today) ? today : (days.has(addDays(today, -1)) ? addDays(today, -1) : null);
  if (!anchor) return 0;
  let streak = 0, cur = anchor;
  while (days.has(cur)) { streak++; cur = addDays(cur, -1); }
  return streak;
}

export function completedToday(sessions, today = dayKey()) {
  return sessions.some((s) => s.completed && s.dayKey === today);
}

/* ---------------- history summary ---------------- */
export function historySummary(sessions, today = dayKey()) {
  const done = sessions.filter((s) => s.completed);
  const last7 = new Set(), last30 = new Set();
  for (let i = 0; i < 30; i++) { const k = addDays(today, -i); if (i < 7) last7.add(k); last30.add(k); }
  let volume = 0, totalSets = 0;
  for (const s of done) for (const set of s.sets) { totalSets++; volume += (set.weight || 0); }
  const perTrial = {};
  for (const s of done) perTrial[s.trialId || s.trialName] = (perTrial[s.trialId || s.trialName] || 0) + 1;
  return {
    total: done.length,
    streak: computeStreak(sessions, today),
    sessions7: done.filter((s) => last7.has(s.dayKey)).length,
    sessions30: done.filter((s) => last30.has(s.dayKey)).length,
    totalSets, volume, perTrial,
    recent: done.slice(0, 10).map((s) => ({ dayKey: s.dayKey, trialName: s.trialName, sets: s.sets.length })),
  };
}

/* ---------------- which trial today ----------------
   Rotates by completed-session count. If today is already done, show what was done. */
export function applyOverrides(trial, overrides) {
  if (!overrides || !overrides[trial.id]) return trial;
  return { ...trial, ex: overrides[trial.id] };
}
export function trialForToday(sessions, today = dayKey(), extras = {}) {
  const { overrides = {}, choices = {} } = extras;
  const todays = sessions.find((s) => s.completed && s.dayKey === today);
  let base;
  if (todays) base = TRIALS.find((t) => t.id === todays.trialId) || TRIALS[0];
  else if (choices[today]) base = TRIALS.find((t) => t.id === choices[today]) || TRIALS[0];
  else { const doneCount = sessions.filter((s) => s.completed).length; base = TRIALS[doneCount % TRIALS.length]; }
  return applyOverrides(base, overrides);
}

/* ---------------- the twin (from recovery) ---------------- */
export function computeTwin(recovery) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r = recovery && recovery[0];
  const fresh = r && (Date.now() - r.ts) < 3 * 864e5;
  const sleep = fresh ? clamp((r.sleep - 4) / 5, 0, 1) : 0.5;
  const ready = fresh ? clamp((r.readiness - 1) / 9, 0, 1) : 0.5;
  const mood = fresh ? clamp((r.mood - 1) / 9, 0, 1) : 0.5;
  const debt = sleep < 0.4 ? 1 : 0, low = ready < 0.35 ? 1 : 0;
  const burnout = clamp(0.44 * (1 - sleep) + 0.28 * (1 - ready) + 0.15 * debt + 0.13 * low - 0.12 * mood, 0, 1);
  const motivation = clamp(0.42 * 0 + 0.22 * mood + 0.2 * (1 - burnout), 0, 1);
  const load = clamp(0.5 * (1 - sleep) + 0.3 * burnout, 0, 1);
  const decision = clamp(0.4 * sleep + 0.3 * (1 - load) + 0.3 * motivation, 0, 1);
  return { burnout, motivation, load, decision };
}

/* ---------------- one honest directive (local, offline) ---------------- */
export function localDirective(sessions, recovery, today = dayKey()) {
  const twin = computeTwin(recovery);
  const streak = computeStreak(sessions, today);
  if (twin.burnout > 0.6) return {
    directive: 'Do not train today. Sleep before midnight.',
    why: `Burnout risk is at ${Math.round(twin.burnout * 100)}%. Every rep you add now is drawn from a body already overdrawn.`,
    confidence: 88,
  };
  if (streak === 0) return {
    directive: 'Begin one trial. Today, not tomorrow.',
    why: 'You have no streak to protect — nothing to lose, everything to start. The first rep is the only one that matters.',
    confidence: 82,
  };
  if (twin.decision < 0.4) return {
    directive: 'Decide nothing large today. Train, eat, sleep.',
    why: `Decision quality is modeled at ${Math.round(twin.decision * 100)}%. Sleep debt makes impulse feel like clarity.`,
    confidence: 71,
  };
  return {
    directive: "Complete today's trial without shortening it.",
    why: `Streak at ${streak}, burnout low. This is where consistency compounds.`,
    confidence: 76,
  };
}

/* ---------------- export/import round-trip ---------------- */
export function makeBackup(events, deviceId) {
  return JSON.stringify({ app: 'ascension', v: SCHEMA_VERSION, deviceId, exported: Date.now(), events }, null, 0);
}
export function readBackup(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  if (!o || o.app !== 'ascension' || !Array.isArray(o.events)) throw new Error('not an Ascension backup');
  return o.events;
}
