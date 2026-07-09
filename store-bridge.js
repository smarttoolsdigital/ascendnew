// store-bridge.js
// Lets the Training Hall (or any view) write to the SAME durable event log the
// daily-driver app uses, so a workout logged in the Hall shows up in the app's
// streak and history. Load it as a module in hall.html:
//   <script type="module" src="./store-bridge.js"></script>
// Then, from the Hall's normal code, call window.Ascension.* (all guarded/async).
import * as C from './core.js';
import { openStore } from './db.js';

const ready = (async () => {
  const store = await openStore();
  const events = await store.all();
  return {
    store,
    events,
    fold: () => C.foldEvents(events),
    push: async (evt) => { events.push(evt); try { await store.append(evt); } catch (e) { /* keep going */ } return evt; },
  };
})();
const ctx = () => ready;

function resumeOrNew(state, sessionId) {
  if (sessionId) return sessionId;
  const today = C.dayKey();
  const inprogress = state.sessions.find((s) => !s.completed && s.sets.some((x) => C.dayKey(new Date(x.ts)) === today));
  return inprogressId(inprogress) || C.newId('s');
}
function inprogressId(s) { return s && s.id; }

window.Ascension = {
  ready,
  /** Log one set. Returns the sessionId so the caller can keep passing it. */
  async logSet(exercise, weight, sessionId) {
    const c = await ctx();
    const st = c.fold();
    const sid = resumeOrNew(st, sessionId);
    const idx = (st.sessions.find((s) => s.id === sid)?.sets.filter((x) => x.exercise === exercise).length) || 0;
    await c.push(C.EV.setLogged(sid, exercise, weight, idx, c.store.deviceId));
    return sid;
  },
  /** Mark today's trial complete. */
  async completeSession(trialId, trialName, sessionId) {
    const c = await ctx();
    const st = c.fold();
    const sid = resumeOrNew(st, sessionId);
    await c.push(C.EV.sessionCompleted(sid, trialId, trialName, C.dayKey(), c.store.deviceId));
  },
  /** Log last night. */
  async logRecovery(sleep, readiness, mood) {
    const c = await ctx();
    await c.push(C.EV.recoveryLogged(sleep, readiness, mood, c.store.deviceId));
  },
  /** Read the canonical derived state (streak, history, etc.) for display. */
  async summary() {
    const c = await ctx();
    const st = c.fold();
    return {
      ...C.historySummary(st.sessions),
      completedToday: C.completedToday(st.sessions),
      trialToday: C.trialForToday(st.sessions),
      backend: c.store.backend,
      deviceId: c.store.deviceId,
    };
  },
};
