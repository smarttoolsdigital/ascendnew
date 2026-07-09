// core.test.mjs — run: node core.test.mjs
import {
  EV, foldEvents, computeStreak, historySummary, trialForToday,
  completedToday, localDirective, makeBackup, readBackup, dayKey, newId,
} from './core.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name); } };

const DEV = 'dev_test';
function dk(offset) { const d = new Date(); d.setDate(d.getDate() + offset); return dayKey(d); }

// helper: a completed session on a given dayKey
function completedSession(events, key, trialId, trialName, sets = 3) {
  const sid = newId('s');
  for (let i = 0; i < sets; i++) events.push(EV.setLogged(sid, 'Test Lift', 40, i, DEV));
  const e = EV.sessionCompleted(sid, trialId, trialName, key, DEV);
  events.push(e);
  return events;
}

// 1. fold: sets + completion -> one completed session
{
  const ev = []; completedSession(ev, dk(0), 'anterior', 'The Anterior Trial', 3);
  const { sessions } = foldEvents(ev);
  ok('fold builds one session', sessions.length === 1);
  ok('fold captures sets', sessions[0].sets.length === 3);
  ok('fold marks completed', sessions[0].completed === true);
}

// 2. fold is order-independent + dedupes (the sync contract)
{
  const ev = []; completedSession(ev, dk(0), 'anterior', 'A', 2);
  const shuffled = [...ev].reverse();
  const dup = [...ev, ...ev]; // duplicate every event
  const a = foldEvents(ev), b = foldEvents(shuffled), c = foldEvents(dup);
  ok('order-independent session count', a.sessions.length === b.sessions.length);
  ok('dedupe: duplicates do not double-count', c.sessions.length === 1 && c.sessions[0].sets.length === 2);
}

// 3. streaks
{
  // three consecutive days ending today
  let ev = []; completedSession(ev, dk(-2), 'a', 'A'); completedSession(ev, dk(-1), 'b', 'B'); completedSession(ev, dk(0), 'c', 'C');
  ok('streak of 3 consecutive incl today', computeStreak(foldEvents(ev).sessions) === 3);

  // today missing but yesterday done -> streak alive (2: yesterday + day before)
  ev = []; completedSession(ev, dk(-2), 'a', 'A'); completedSession(ev, dk(-1), 'b', 'B');
  ok('streak alive when today not yet done', computeStreak(foldEvents(ev).sessions) === 2);

  // gap breaks it: done 3 days ago and today, but not the two between
  ev = []; completedSession(ev, dk(-3), 'a', 'A'); completedSession(ev, dk(0), 'b', 'B');
  ok('gap breaks streak (today only = 1)', computeStreak(foldEvents(ev).sessions) === 1);

  // no sessions
  ok('empty streak = 0', computeStreak([]) === 0);

  // two sessions same day shouldn't inflate streak
  ev = []; completedSession(ev, dk(0), 'a', 'A'); completedSession(ev, dk(0), 'b', 'B');
  ok('same-day double session = streak 1', computeStreak(foldEvents(ev).sessions) === 1);
}

// 4. completedToday + trial rotation
{
  let ev = []; ok('nothing done today', completedToday(foldEvents(ev).sessions) === false);
  completedSession(ev, dk(0), 'anterior', 'The Anterior Trial');
  ok('completedToday true after logging', completedToday(foldEvents(ev).sessions) === true);
  ok('today shows the trial that was done', trialForToday(foldEvents(ev).sessions).id === 'anterior');

  // rotation advances with completed count
  ev = []; completedSession(ev, dk(-1), 'anterior', 'A');
  ok('next trial rotates after 1 done', trialForToday(foldEvents(ev).sessions).id === 'posterior');
}

// 5. history summary
{
  const ev = [];
  completedSession(ev, dk(-1), 'anterior', 'A', 5);
  completedSession(ev, dk(0), 'posterior', 'B', 4);
  const h = historySummary(foldEvents(ev).sessions);
  ok('history total', h.total === 2);
  ok('history sets counted', h.totalSets === 9);
  ok('history last7', h.sessions7 === 2);
  ok('history volume = sum weights', h.volume === 9 * 40);
}

// 6. recovery + directive (offline)
{
  const ev = [EV.recoveryLogged(4.5, 3, 4, DEV)]; // poor night
  const { recovery } = foldEvents(ev);
  const d = localDirective([], recovery);
  ok('depleted night -> rest directive', /Do not train/.test(d.directive));

  const good = foldEvents([EV.recoveryLogged(8, 8, 8, DEV)]).recovery;
  const d2 = localDirective([], good);
  ok('good night, no streak -> begin directive', /Begin one trial/.test(d2.directive));
}

// 6.5 workout editing + trial choice
{
  const ev = [];
  // choose posterior explicitly today (rotation would give anterior)
  ev.push(EV.trialChosen('posterior', dk(0), DEV));
  // edit posterior: change first exercise
  const newEx = [{ n: 'Trap Bar Deadlift', s: 4, r: '8–12', w: 60 }];
  ev.push(EV.planUpdated('posterior', newEx, DEV));
  const st = foldEvents(ev);
  const t = trialForToday(st.sessions, dk(0), { overrides: st.planOverrides, choices: st.trialChoices });
  ok('trial choice honored', t.id === 'posterior');
  ok('plan override applied', t.ex.length === 1 && t.ex[0].n === 'Trap Bar Deadlift');
  // latest edit wins
  ev.push(EV.planUpdated('posterior', [{ n: 'RDL', s: 4, r: '10', w: 35 }], DEV));
  const st2 = foldEvents(ev);
  ok('latest plan edit wins', st2.planOverrides.posterior[0].n === 'RDL');
  // completed session overrides choice for display
  completedSession(ev, dk(0), 'anterior', 'A');
  const st3 = foldEvents(ev);
  const t3 = trialForToday(st3.sessions, dk(0), { overrides: st3.planOverrides, choices: st3.trialChoices });
  ok('done trial beats choice', t3.id === 'anterior');
  // backward compat: old signature still works
  ok('old signature compatible', trialForToday(st3.sessions).id === 'anterior');
}

// 7. backup round-trip (data safety)
{
  const ev = []; completedSession(ev, dk(0), 'anterior', 'A', 3);
  const json = makeBackup(ev, DEV);
  const restored = readBackup(json);
  const before = foldEvents(ev), after = foldEvents(restored);
  ok('backup round-trips events', restored.length === ev.length);
  ok('restored folds identically', after.sessions.length === before.sessions.length && after.sessions[0].sets.length === 3);
  let threw = false; try { readBackup('{"app":"other"}'); } catch { threw = true; }
  ok('rejects foreign backup', threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
