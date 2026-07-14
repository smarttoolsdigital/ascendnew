// core.test.mjs — run: node core.test.mjs
import {
  EV, foldEvents, computeStreak, historySummary, trialForToday,
  completedToday, localDirective, makeBackup, readBackup, dayKey, newId,
  personalRecords, lastPerformance, longestStreak, lumenLine,
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

// 6.6 v1.3: undo, warm-ups, notes, PRs, previous performance
{
  // undo removes exactly the voided set
  let ev = []; const sid = newId('s');
  const e1 = EV.setLogged(sid, 'Row', 40, 0, DEV); const e2 = EV.setLogged(sid, 'Row', 40, 1, DEV);
  ev.push(e1, e2, EV.setVoided(e2.id, DEV));
  ok('void removes one set', foldEvents(ev).sessions[0].sets.length === 1);

  // warm sets excluded from volume + PR, included in the session
  ev = []; const sid2 = newId('s');
  ev.push(EV.setLogged(sid2, 'Squat', 20, 0, DEV, true));   // warm-up
  ev.push(EV.setLogged(sid2, 'Squat', 50, 1, DEV));
  ev.push(EV.sessionCompleted(sid2, 'anterior', 'A', dk(0), DEV));
  const st = foldEvents(ev);
  const h = historySummary(st.sessions);
  ok('warm excluded from volume', h.volume === 50 && h.totalSets === 1);
  ok('warm excluded from PR', personalRecords(st.sessions).Squat === 50);

  // notes: latest wins
  ev.push(EV.noteAdded('Squat', 'pause in the hole', DEV));
  ev.push(EV.noteAdded('Squat', 'belt on top sets', DEV));
  ok('latest note wins', foldEvents(ev).notes.Squat === 'belt on top sets');

  // previous performance: reads yesterday, skips today
  ev = [];
  completedSession(ev, dk(-1), 'a', 'A', 3);                 // 3 sets of Test Lift @ 40 yesterday
  const lp = lastPerformance(foldEvents(ev).sessions, 'Test Lift', dk(0));
  ok('last performance found', lp && lp.sets === 3 && lp.weight === 40);
  completedSession(ev, dk(0), 'b', 'B', 2);                  // today's should NOT be "last"
  const lp2 = lastPerformance(foldEvents(ev).sessions, 'Test Lift', dk(0));
  ok('last performance skips today', lp2 && lp2.dayKey === dk(-1));
}

// 6.7 v1.5: longest streak + Lumen local lines
{
  // longest streak: 3-day run in the past beats current 1
  let ev = [];
  completedSession(ev, dk(-9), 'a', 'A'); completedSession(ev, dk(-8), 'a', 'A'); completedSession(ev, dk(-7), 'a', 'A');
  completedSession(ev, dk(0), 'a', 'A');
  const st = foldEvents(ev);
  ok('longest streak found', longestStreak(st.sessions) === 3);

  // abandoned session yesterday -> "You stopped after X."
  ev = []; const sid = newId('s');
  const yts = new Date(); yts.setDate(yts.getDate() - 1);
  ev.push({ ...EV.setLogged(sid, 'Romanian Deadlift', 35, 0, DEV), ts: yts.getTime() });
  const line = lumenLine(foldEvents(ev));
  ok('Lumen names the abandonment', line === 'You stopped after Romanian Deadlift.');

  // chasing your record
  ev = [];
  completedSession(ev, dk(-9), 'a', 'A'); completedSession(ev, dk(-8), 'a', 'A');
  completedSession(ev, dk(-7), 'a', 'A'); completedSession(ev, dk(-6), 'a', 'A'); completedSession(ev, dk(-5), 'a', 'A');
  completedSession(ev, dk(-1), 'a', 'A');   // current streak 1, best 5
  const l2 = lumenLine(foldEvents(ev));
  ok('Lumen counts days to the record', l2 === '5 days until this becomes your longest streak.');

  // done today
  ev = []; completedSession(ev, dk(0), 'a', 'A');
  ok('Lumen closes the day', lumenLine(foldEvents(ev)) === 'Today is already written.');
}

// 6.8 v1.6.4: reopen a completed day
{
  let ev = []; const sid = newId('s');
  const done = EV.sessionCompleted(sid, 'anterior', 'A', dk(0), DEV);
  ev.push(done);
  ok('completed before void', completedToday(foldEvents(ev).sessions) === true);
  ev.push(EV.sessionVoided(done.id, DEV));
  const st = foldEvents(ev);
  ok('void reopens the day', completedToday(st.sessions) === false);
  ok('void kills the streak', computeStreak(st.sessions) === 0);
  // re-completing the same session works (new completion event id)
  ev.push(EV.sessionCompleted(sid, 'anterior', 'A', dk(0), DEV));
  ok('re-complete after reopen', completedToday(foldEvents(ev).sessions) === true);
}

// 6.9 v1.8: custom structure + profile
{
  const ev = [];
  ev.push(EV.structureUpdated([
    { id: 'push', name: 'Push Day', focus: 'Chest · Shoulders', ex: [{ n: 'DB Press', s: 4, r: '8–12', w: 35 }] },
    { id: 'pull', name: 'Pull Day', focus: 'Back · Biceps', ex: [{ n: 'Row', s: 4, r: '8–12', w: 35 }] },
  ], DEV));
  const st = foldEvents(ev);
  ok('structure folds', st.structure && st.structure.length === 2);
  const t0 = trialForToday(st.sessions, dk(0), { structure: st.structure });
  ok('rotation uses custom structure', t0.id === 'push');
  completedSession(ev, dk(0), 'push', 'Push Day');
  const st2 = foldEvents(ev);
  const t1 = trialForToday(st2.sessions, dk(1), { structure: st2.structure });
  ok('custom rotation advances', t1.id === 'pull');
  ev.push(EV.profileUpdated({ equipment: 'full gym' }, DEV));
  ev.push(EV.profileUpdated({ maxLoad: 100 }, DEV));
  const st3 = foldEvents(ev);
  ok('profile merges latest-wins per field', st3.profile.equipment === 'full gym' && st3.profile.maxLoad === 100);
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
