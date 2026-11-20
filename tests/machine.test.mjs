// C10 reducer obligations (node T1): timer end, agent linger, closed-lid blocks and their hysteresis, block
// priority, sleepNow (D7), the AC trigger edge, suppression and trigger-only end, commands and settings edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, step } from '../mods/herdr-caffeinate/core/machine.js';
import { buildShared, defaultSettings } from '../mods/herdr-caffeinate/core/state.js';

const T0 = 1763568000000;
const MIN = 60000;
const INSTALLED = { sudo: true, failsafe: true };
// On AC, full battery, cool, lid open, nothing working, installed, no claim.
const BASE = { ac: true, percent: 100, sleepDisabled: false, lidClosed: false, lidCausesSleep: true, thermal: 0, working: 0, install: INSTALLED };
const CLOSED = { lidClosed: true, lidCausesSleep: true };

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') merge(target[key], value);
    else target[key] = value;
  }
  return target;
}
const config = (patch = {}) => merge(defaultSettings(), patch);

// A minimal engine: keeps the reducer state, the last facts and the settings between steps, applies `settings`
// effects, and holds the claim exactly while closed-lid is desired (a successful engage).
function engine(settingsPatch = {}, runtime = null) {
  let state = initialState(runtime);
  let settings = config(settingsPatch);
  let facts = { ...BASE };
  let claim = false;
  const self = {
    get state() { return state; },
    get settings() { return settings; },
    run(event, factPatch = {}) {
      facts = { ...facts, ...factPatch };
      const out = step(state, event, { ...facts, claimHeld: claim }, settings);
      state = out.state;
      for (const effect of out.effects) if (effect.type === 'settings') settings = effect.settings;
      claim = out.desired.closedLid;
      return out;
    },
    boot: (now, factPatch) => self.run({ type: 'boot', now }, factPatch),
    tick: (now, factPatch) => self.run({ type: 'tick', now }, factPatch),
    poke: (now, factPatch) => self.run({ type: 'poke', now }, factPatch),
    command: (now, command, factPatch) => self.run({ type: 'command', now, command }, factPatch),
    edit(patch) { settings = merge(structuredClone(settings), patch); },
  };
  return self;
}
const lidView = (state) => ({ status: state.closedLid.status, blocked: state.closedLid.blocked });
const sessionOf = (state) => state.session && [state.session.mode, state.session.origin];

// ── Awake ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('timer: awake at endsAt − 1, Off at endsAt', () => {
  const e = engine();
  e.boot(T0);
  const start = e.command(T0, 'timer:2');
  assert.equal(start.desired.awake, true);
  assert.deepEqual(e.state.session, { mode: 'timer', origin: 'user', startedAt: T0, endsAt: T0 + 2 * MIN });
  assert.equal(e.settings.mode, 'timer');
  assert.equal(e.settings.timer.lastCustomMin, 2);
  assert.equal(buildShared(e.state, INSTALLED, T0).endsAt, T0 + 2 * MIN);
  const before = e.tick(T0 + 2 * MIN - 1);
  assert.equal(before.desired.awake, true);
  assert.equal(buildShared(e.state, INSTALLED, T0 + 2 * MIN - 1).mode, 'timer');
  const end = e.tick(T0 + 2 * MIN);
  assert.equal(end.desired.awake, false);
  assert.equal(e.state.session, null);
  assert.ok(end.effects.some((x) => x.type === 'settings' && x.settings.mode === 'off'));
  assert.equal(e.settings.mode, 'off');
  assert.equal(buildShared(e.state, INSTALLED, T0 + 2 * MIN).mode, 'off');
});

test('timer resumes after a reload only while endsAt is ahead', () => {
  const runtime = { v: 1, session: { mode: 'timer', origin: 'user', startedAt: T0, endsAt: T0 + MIN }, holder: null, keeper: null, trigger: { suppressed: false, lastAc: true } };
  const live = engine({ mode: 'timer' }, runtime);
  assert.equal(live.boot(T0 + MIN - 1).desired.awake, true);
  assert.equal(live.settings.mode, 'timer');
  const late = engine({ mode: 'timer' }, runtime);
  assert.equal(late.boot(T0 + MIN).desired.awake, false);
  assert.equal(late.state.session, null);
  assert.equal(late.settings.mode, 'off');
  const lost = engine({ mode: 'timer' });
  assert.equal(lost.boot(T0).desired.awake, false);
  assert.equal(lost.settings.mode, 'off');
});

test('timer bounds: timer:0, timer:1441, timer:abc change nothing and log once; timer:1440 ends 24 h ahead; cancel ends it', () => {
  const e = engine();
  e.boot(T0);
  for (const bad of ['timer:0', 'timer:1441', 'timer:abc']) {
    const out = e.command(T0, bad);
    assert.equal(e.state.session, null, bad);
    assert.deepEqual(out.effects.map((x) => x.type), ['log'], bad);
    assert.match(out.effects[0].message, /ignored command/);
  }
  assert.equal(e.settings.mode, 'off');
  const day = e.command(T0, 'timer:1440');
  assert.equal(day.desired.awake, true);
  assert.equal(e.state.session.endsAt, T0 + 24 * 60 * MIN);
  const cancel = e.command(T0 + 1000, 'timer:cancel');
  assert.equal(cancel.desired.awake, false);
  assert.equal(e.state.session, null);
  assert.equal(e.settings.mode, 'off');
  assert.deepEqual(e.command(T0 + 2000, 'timer:cancel').effects, []);
});

test('agent linger boundary: awake while working and until lingerSec after the last working time', () => {
  const e = engine({ mode: 'agent' });
  assert.equal(e.boot(T0).desired.awake, false);
  assert.equal(e.tick(T0 + 1000, { working: 2 }).desired.awake, true);
  assert.equal(buildShared(e.state, INSTALLED, T0 + 1000).reason, 'agent');
  assert.equal(e.tick(T0 + 1000 + 30000 - 1, { working: 0 }).desired.awake, true);
  assert.equal(e.tick(T0 + 1000 + 30000).desired.awake, false);
  const shared = buildShared(e.state, INSTALLED, T0 + 31000);
  assert.deepEqual([shared.mode, shared.active, shared.reason], ['agent', false, null]);
  const now = engine({ mode: 'agent', agent: { lingerSec: 0 } });
  now.boot(T0, { working: 1 });
  assert.equal(now.tick(T0 + 1, { working: 0 }).desired.awake, false);
});

test('mode on and off; toggle returns to the last of on and agent', () => {
  const e = engine();
  e.boot(T0);
  assert.equal(e.command(T0, 'toggle').desired.awake, true);
  assert.deepEqual(sessionOf(e.state), ['on', 'user']);
  assert.equal(buildShared(e.state, INSTALLED, T0).reason, 'user');
  const again = e.command(T0 + 5, 'mode:on');
  assert.deepEqual(again.effects, []);
  assert.equal(e.state.session.startedAt, T0);
  e.command(T0, 'mode:agent');
  assert.equal(e.settings.mode, 'agent');
  e.command(T0, 'toggle');
  assert.equal(e.state.session, null);
  assert.equal(e.settings.mode, 'off');
  e.command(T0, 'toggle');
  assert.deepEqual(sessionOf(e.state), ['agent', 'user']);
  e.command(T0, 'timer:15');
  assert.equal(e.settings.timer.lastCustomMin, 45);
  e.command(T0, 'toggle');
  assert.equal(e.state.session, null);
  e.command(T0, 'toggle');
  assert.deepEqual(sessionOf(e.state), ['agent', 'user']);
  assert.equal(e.command(T0, 'mode:off').desired.awake, false);
});

test('display is held only while awake and the display toggle is on', () => {
  const e = engine();
  e.boot(T0);
  let out = e.command(T0, 'display:on');
  assert.equal(e.settings.display, true);
  assert.equal(out.desired.display, false);
  assert.deepEqual(out.effects.map((x) => x.type), ['settings']);
  out = e.command(T0, 'mode:on');
  assert.equal(out.desired.display, true);
  assert.equal(buildShared(e.state, INSTALLED, T0).display, true);
  out = e.command(T0, 'display:toggle');
  assert.equal(out.desired.display, false);
  assert.equal(e.settings.display, false);
  assert.deepEqual(e.command(T0, 'display:off').effects, []);
});

// ── Closed-lid ───────────────────────────────────────────────────────────────────────────────────────────────────

test('closed-lid is never wanted while not awake', () => {
  const e = engine({ closedLid: { enabled: true } });
  assert.equal(e.boot(T0).desired.closedLid, false);
  assert.deepEqual(e.state.closedLid, { wanted: false, status: 'off', blocked: null, engaged: false });
  let out = e.command(T0, 'mode:agent');
  assert.equal(out.desired.awake, false);
  assert.equal(out.desired.closedLid, false);
  out = e.command(T0, 'timer:1');
  assert.equal(out.desired.closedLid, true);
  assert.deepEqual(lidView(e.state), { status: 'engaged', blocked: null });
  out = e.tick(T0 + MIN);
  assert.equal(out.desired.awake, false);
  assert.equal(out.desired.closedLid, false);
  assert.deepEqual(e.state.closedLid, { wanted: false, status: 'off', blocked: null, engaged: false });
});

test('battery: equal to floor is not blocked, floor − 1 is blocked, the block holds at floor + 4 and clears at floor + 5', () => {
  const e = engine({ mode: 'on', closedLid: { enabled: true, acOnly: false, batteryFloor: 20 } });
  assert.equal(e.boot(T0, { ac: false, percent: 20 }).desired.closedLid, true);
  assert.deepEqual(lidView(e.state), { status: 'engaged', blocked: null });
  let out = e.tick(T0 + 10000, { percent: 19 });
  assert.equal(out.desired.closedLid, false);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'battery' });
  out = e.tick(T0 + 20000, { percent: 24 });
  assert.equal(out.desired.closedLid, false);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'battery' });
  out = e.tick(T0 + 30000, { percent: 25 });
  assert.equal(out.desired.closedLid, true);
  assert.deepEqual(lidView(e.state), { status: 'engaged', blocked: null });
});

test('battery: the block clears on AC and never applies on AC', () => {
  const e = engine({ mode: 'on', closedLid: { enabled: true, acOnly: false } });
  e.boot(T0, { ac: false, percent: 10 });
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'battery' });
  assert.equal(e.tick(T0 + 10000, { ac: true }).desired.closedLid, true);
  assert.equal(e.tick(T0 + 20000, { percent: 5 }).desired.closedLid, true);
});

test('thermal: 1 is allowed, 2 blocks, and two probes at 1 or below clear the block', () => {
  const e = engine({ mode: 'on', closedLid: { enabled: true } });
  assert.equal(e.boot(T0, { thermal: 1 }).desired.closedLid, true);
  let out = e.tick(T0 + 10000, { thermal: 2 });
  assert.equal(out.desired.closedLid, false);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'thermal' });
  e.tick(T0 + 20000, { thermal: 1 });
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'thermal' });
  e.poke(T0 + 25000);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'thermal' }, 'a poke is not a probe');
  out = e.tick(T0 + 30000, { thermal: 0 });
  assert.equal(out.desired.closedLid, true);
  assert.deepEqual(lidView(e.state), { status: 'engaged', blocked: null });
  // A hot or unreadable probe restarts the count.
  for (const [i, thermal] of [3, 1, 2, 1, null, 1].entries()) e.tick(T0 + 40000 + i, { thermal });
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'thermal' });
  assert.equal(e.tick(T0 + 50000, { thermal: 1 }).desired.closedLid, true);
});

test('acOnly: unplugging blocks closed-lid as ac; without acOnly it stays engaged', () => {
  const e = engine({ mode: 'on', closedLid: { enabled: true, acOnly: true } });
  assert.equal(e.boot(T0).desired.closedLid, true);
  const out = e.tick(T0 + 10000, { ac: false, percent: 80 });
  assert.equal(out.desired.closedLid, false);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'ac' });
  assert.equal(e.tick(T0 + 20000, { ac: true }).desired.closedLid, true);
  const free = engine({ mode: 'on', closedLid: { enabled: true, acOnly: false } });
  free.boot(T0);
  assert.equal(free.tick(T0 + 10000, { ac: false, percent: 80 }).desired.closedLid, true);
});

test('unknown: 3 consecutive unreadable probes block closed-lid, 2 do not', () => {
  const e = engine({ mode: 'on', closedLid: { enabled: true } });
  e.boot(T0);
  assert.equal(e.tick(T0 + 10000, { ac: null }).desired.closedLid, true);
  assert.equal(e.tick(T0 + 20000).desired.closedLid, true);
  assert.equal(e.poke(T0 + 25000).desired.closedLid, true, 'a poke is not a probe');
  assert.equal(e.tick(T0 + 30000).desired.closedLid, false);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'unknown' });
  assert.equal(e.tick(T0 + 40000, { ac: true }).desired.closedLid, true);
  // On battery the percentage must be readable; while wanted, so must the thermal state.
  e.tick(T0 + 50000, { ac: false, percent: null });
  e.tick(T0 + 60000, { ac: true, thermal: null });
  assert.equal(e.tick(T0 + 70000).desired.closedLid, false);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'unknown' });
  // Thermal is not read while closed-lid is not wanted, so its absence does not count then.
  const idle = engine({ mode: 'on' });
  idle.boot(T0, { thermal: null });
  idle.tick(T0 + 10000);
  idle.tick(T0 + 20000);
  assert.equal(idle.command(T0 + 21000, 'closed-lid:on').desired.closedLid, true);
});

test('closed-lid block priority: unavailable > other-instance > external > thermal > battery > ac > unknown', () => {
  const hot = { thermal: 2 };
  const low = { ac: false, percent: 5 };
  const cases = [
    [{ install: { sudo: false, failsafe: true }, otherInstance: true, sleepDisabled: true, ...hot, ...low }, 'unavailable', null],
    [{ install: { sudo: true, failsafe: false } }, 'unavailable', null],
    [{ unavailable: true, otherInstance: true, sleepDisabled: true, ...hot, ...low }, 'unavailable', null],
    [{ otherInstance: true, sleepDisabled: true, ...hot, ...low }, 'blocked', 'other-instance'],
    [{ sleepDisabled: true, ...hot, ...low }, 'external', null],
    [{ ...hot, ...low }, 'blocked', 'thermal'],
    [{ ...low }, 'blocked', 'battery'],
    [{ ac: false, percent: 80 }, 'blocked', 'ac'],
  ];
  for (const [facts, status, blocked] of cases) {
    const e = engine({ mode: 'on', closedLid: { enabled: true, acOnly: true } });
    assert.equal(e.boot(T0, facts).desired.closedLid, false, JSON.stringify(facts));
    assert.deepEqual(lidView(e.state), { status, blocked }, JSON.stringify(facts));
    assert.equal(e.state.closedLid.wanted, true);
  }
  // unknown ranks last: a thermal block outranks it until thermal clears.
  const e = engine({ mode: 'on', closedLid: { enabled: true } });
  e.boot(T0, { ac: null, thermal: 2 });
  e.tick(T0 + 1);
  e.tick(T0 + 2);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'thermal' });
  e.tick(T0 + 3, { thermal: 0 });
  e.tick(T0 + 4);
  assert.deepEqual(lidView(e.state), { status: 'blocked', blocked: 'unknown' });
});

test('closed-lid status is external whenever SleepDisabled is 1 without our claim, enabled or not', () => {
  const off = engine();
  off.boot(T0, { sleepDisabled: true });
  assert.deepEqual(off.state.closedLid, { wanted: false, status: 'external', blocked: null, engaged: false });
  assert.deepEqual(buildShared(off.state, INSTALLED, T0).closedLid, { wanted: false, status: 'external', blocked: null });
  const on = engine({ mode: 'on', closedLid: { enabled: true } });
  assert.equal(on.boot(T0, { sleepDisabled: true }).desired.closedLid, false);
  assert.deepEqual(lidView(on.state), { status: 'external', blocked: null });
  // Our own SleepDisabled 1 (claim held) is not external.
  const ours = engine({ mode: 'on', closedLid: { enabled: true } });
  ours.boot(T0);
  assert.equal(ours.tick(T0 + 10000, { sleepDisabled: true }).desired.closedLid, true);
  assert.deepEqual(lidView(ours.state), { status: 'engaged', blocked: null });
  const plain = engine({ mode: 'on' });
  plain.boot(T0);
  assert.deepEqual(lidView(plain.state), { status: 'off', blocked: null });
});

// ── sleepNow (D7) ────────────────────────────────────────────────────────────────────────────────────────────────

test('sleepNow only when closed-lid ends with the lid closed and causing sleep', () => {
  const cases = [[true, true, true], [true, false, false], [false, true, false], [null, true, false], [true, null, false]];
  for (const [lidClosed, lidCausesSleep, expected] of cases) {
    const e = engine({ mode: 'on', closedLid: { enabled: true } });
    const engage = e.boot(T0, { lidClosed, lidCausesSleep });
    assert.equal(engage.desired.closedLid, true);
    assert.equal(engage.desired.sleepNow, false);
    const out = e.command(T0 + 1000, 'closed-lid:off');
    assert.equal(out.desired.closedLid, false);
    assert.equal(out.desired.sleepNow, expected, `lidClosed ${lidClosed}, lidCausesSleep ${lidCausesSleep}`);
  }
});

test('sleepNow on every engaged → not-engaged transition (mode Off, a block, the timer end), once each', () => {
  const off = engine({ mode: 'on', closedLid: { enabled: true } });
  off.boot(T0, CLOSED);
  assert.equal(off.command(T0 + 1, 'mode:off').desired.sleepNow, true);
  assert.equal(off.tick(T0 + 10000).desired.sleepNow, false);
  const blocked = engine({ mode: 'on', closedLid: { enabled: true, acOnly: false } });
  blocked.boot(T0, CLOSED);
  assert.equal(blocked.tick(T0 + 10000, { ac: false, percent: 5 }).desired.sleepNow, true);
  assert.equal(blocked.tick(T0 + 20000).desired.sleepNow, false);
  assert.equal(blocked.tick(T0 + 30000, { ac: true }).desired.closedLid, true);
  assert.equal(blocked.tick(T0 + 40000, { thermal: 2 }).desired.sleepNow, true);
  const timer = engine({ closedLid: { enabled: true } });
  timer.boot(T0, CLOSED);
  assert.equal(timer.command(T0, 'timer:1').desired.closedLid, true);
  assert.equal(timer.tick(T0 + MIN).desired.sleepNow, true);
});

test('sleepNow never fires without an engaged closed-lid', () => {
  const e = engine({ mode: 'on', closedLid: { enabled: true, acOnly: true } });
  const out = e.boot(T0, { ac: false, percent: 80, ...CLOSED });
  assert.equal(out.desired.closedLid, false);
  assert.equal(out.desired.sleepNow, false);
  assert.equal(e.command(T0 + 1, 'mode:off').desired.sleepNow, false);
  const plain = engine({ mode: 'on' });
  plain.boot(T0, CLOSED);
  assert.equal(plain.command(T0 + 1, 'mode:off').desired.sleepNow, false);
});

test('sleepNow after a reload that still holds our claim', () => {
  const out = step(initialState(null), { type: 'boot', now: T0 }, { ...BASE, ...CLOSED, claimHeld: true }, config());
  assert.equal(out.desired.closedLid, false);
  assert.equal(out.desired.sleepNow, true);
});

// ── The lid holds nothing unless closed-lid is engaged (D7, AT-21) ──────────────────────────────────────────────

// One engine per mode, awake by that mode, at T0 + 1000 after a boot at T0 with `facts`.
function inMode(mode, facts = {}, settingsPatch = {}) {
  if (mode === 'trigger') {
    const e = engine({ trigger: { ac: { enabled: true } }, ...settingsPatch });
    e.boot(T0, { ...facts, ac: false });
    return { e, out: e.tick(T0 + 1000, { ac: true }) };
  }
  const e = engine({ mode: mode === 'timer' ? 'off' : mode, ...settingsPatch });
  e.boot(T0, { ...facts, working: mode === 'agent' ? 1 : 0 });
  return { e, out: mode === 'timer' ? e.command(T0 + 1000, 'timer:5') : e.poke(T0 + 1000) };
}
const MODES = ['on', 'agent', 'timer', 'trigger'];

test('lid shut and causing sleep without an engaged closed-lid: nothing is held in every mode, and no sleepNow', () => {
  const settingsCases = [{}, { closedLid: { enabled: true } }];
  for (const mode of MODES) {
    for (const patch of settingsCases) {
      // closedLid enabled but blocked (thermal) is not engaged either.
      const facts = patch.closedLid ? { ...CLOSED, thermal: 2 } : CLOSED;
      const { e, out } = inMode(mode, facts, patch);
      const label = `${mode} ${JSON.stringify(patch)}`;
      assert.ok(e.state.session, label);
      assert.equal(out.desired.closedLid, false, label);
      assert.equal(out.desired.awake, false, label);
      assert.equal(out.desired.display, false, label);
      assert.equal(out.desired.sleepNow, false, label);
      assert.equal(buildShared(e.state, INSTALLED, T0).active, false, label);
    }
  }
});

test('lid open, or CausesSleep No or unread: each mode holds the Mac awake as usual', () => {
  const lids = [
    { lidClosed: false, lidCausesSleep: true },
    { lidClosed: true, lidCausesSleep: false },
    { lidClosed: null, lidCausesSleep: true },
    { lidClosed: true, lidCausesSleep: null },
  ];
  for (const mode of MODES) {
    for (const lid of lids) {
      const { out } = inMode(mode, lid);
      assert.equal(out.desired.awake, true, `${mode} ${JSON.stringify(lid)}`);
    }
  }
});

test('engaged closed-lid keeps each mode awake with the lid shut; its end stops the holder with sleepNow; the lid opening brings it back', () => {
  for (const mode of MODES) {
    const { e, out } = inMode(mode, CLOSED, { closedLid: { enabled: true, acOnly: false } });
    assert.equal(out.desired.closedLid, true, mode);
    assert.equal(out.desired.awake, true, mode);
    // Battery below the floor ends closed-lid: the same step lets the Mac sleep and asks for sleepNow.
    const end = e.tick(T0 + 2000, { ac: false, percent: 5, working: mode === 'agent' ? 1 : 0 });
    assert.deepEqual([end.desired.closedLid, end.desired.awake, end.desired.sleepNow], [false, false, true], mode);
    assert.equal(e.tick(T0 + 3000).desired.awake, false, `${mode}: still shut`);
    const open = e.tick(T0 + 4000, { lidClosed: false });
    assert.deepEqual([open.desired.awake, open.desired.sleepNow], [mode !== 'trigger', false], `${mode}: lid open`);
  }
});

// ── AC trigger ───────────────────────────────────────────────────────────────────────────────────────────────────

test('AC trigger edge: plugging in with mode Off starts a trigger session', () => {
  const e = engine({ trigger: { ac: { enabled: true } } });
  e.boot(T0, { ac: false });
  assert.equal(e.state.session, null);
  const out = e.tick(T0 + 10000, { ac: true });
  assert.equal(out.desired.awake, true);
  assert.deepEqual(e.state.session, { mode: 'on', origin: 'trigger', startedAt: T0 + 10000, endsAt: null });
  assert.equal(e.settings.mode, 'off');
  assert.ok(out.effects.some((x) => x.type === 'runtime' && x.session?.origin === 'trigger'));
  const shared = buildShared(e.state, INSTALLED, T0 + 10000);
  assert.deepEqual([shared.mode, shared.active, shared.reason], ['on', true, 'trigger']);
  e.tick(T0 + 20000);
  assert.equal(e.state.session.startedAt, T0 + 10000);
});

test('AC trigger edge needs mode Off, the trigger on and a known unplugged state', () => {
  const disabled = engine();
  disabled.boot(T0, { ac: false });
  disabled.tick(T0 + 1, { ac: true });
  assert.equal(disabled.state.session, null);
  const user = engine({ mode: 'agent', trigger: { ac: { enabled: true } } });
  user.boot(T0, { ac: false });
  user.tick(T0 + 1, { ac: true });
  assert.deepEqual(sessionOf(user.state), ['agent', 'user']);
  const fresh = engine({ trigger: { ac: { enabled: true } } });
  fresh.boot(T0);
  assert.equal(fresh.state.session, null, 'no unplugged reading before: no edge');
  const flaky = engine({ trigger: { ac: { enabled: true } } });
  flaky.boot(T0);
  flaky.tick(T0 + 1, { ac: null });
  flaky.tick(T0 + 2, { ac: true });
  assert.equal(flaky.state.session, null, 'an unreadable reading is not an unplug');
  const agent = engine({ trigger: { ac: { enabled: true, mode: 'agent' } } });
  agent.boot(T0, { ac: false });
  assert.equal(agent.tick(T0 + 1, { ac: true }).desired.awake, false);
  assert.deepEqual(sessionOf(agent.state), ['agent', 'trigger']);
  assert.equal(agent.tick(T0 + 2, { working: 1 }).desired.awake, true);
});

test('AC trigger suppression: a user Off on AC suppresses the trigger until the next unplug', () => {
  const e = engine({ trigger: { ac: { enabled: true } } });
  e.boot(T0, { ac: false });
  e.tick(T0 + 10000, { ac: true });
  assert.deepEqual(sessionOf(e.state), ['on', 'trigger']);
  e.tick(T0 + 20000, { ac: false });
  assert.equal(e.state.session, null);
  e.tick(T0 + 30000, { ac: true });
  assert.deepEqual(sessionOf(e.state), ['on', 'trigger']);
  e.command(T0 + 31000, 'mode:off');
  assert.equal(e.state.session, null);
  assert.equal(e.state.trigger.suppressed, true);
  e.tick(T0 + 40000);
  e.tick(T0 + 50000);
  assert.equal(e.state.session, null);
  assert.equal(buildShared(e.state, INSTALLED, T0 + 50000).active, false);
  e.tick(T0 + 60000, { ac: false });
  assert.equal(e.state.trigger.suppressed, false);
  e.tick(T0 + 70000, { ac: true });
  assert.deepEqual(sessionOf(e.state), ['on', 'trigger']);
});

test('AC trigger suppression blocks an edge seen in the same step as the user Off; Off on battery does not suppress', () => {
  const e = engine({ trigger: { ac: { enabled: true } } });
  e.boot(T0, { ac: false });
  e.command(T0 + 1000, 'mode:off', { ac: true });
  assert.equal(e.state.session, null);
  assert.equal(e.state.trigger.suppressed, true);
  const battery = engine({ mode: 'on', trigger: { ac: { enabled: true } } });
  battery.boot(T0, { ac: false });
  battery.command(T0 + 1000, 'toggle');
  assert.equal(battery.state.session, null);
  assert.equal(battery.state.trigger.suppressed, false);
});

test('AC trigger: unplugging ends only trigger sessions', () => {
  const on = engine({ mode: 'on', trigger: { ac: { enabled: true } } });
  on.boot(T0);
  on.tick(T0 + 10000, { ac: false });
  assert.deepEqual(sessionOf(on.state), ['on', 'user']);
  const timer = engine({ trigger: { ac: { enabled: true } } });
  timer.boot(T0);
  timer.command(T0, 'timer:30');
  timer.tick(T0 + 10000, { ac: false });
  assert.deepEqual(sessionOf(timer.state), ['timer', 'user']);
  // A user mode taken over a trigger session survives the unplug.
  const taken = engine({ trigger: { ac: { enabled: true } } });
  taken.boot(T0, { ac: false });
  taken.tick(T0 + 1, { ac: true });
  taken.command(T0 + 2, 'mode:on');
  assert.deepEqual(sessionOf(taken.state), ['on', 'user']);
  taken.tick(T0 + 3, { ac: false });
  assert.deepEqual(sessionOf(taken.state), ['on', 'user']);
});

test('a trigger session resumes after a reload while the trigger is on, and ends on unplug', () => {
  const runtime = { v: 1, session: { mode: 'on', origin: 'trigger', startedAt: T0, endsAt: null }, holder: null, keeper: null, trigger: { suppressed: false, lastAc: true } };
  const e = engine({ trigger: { ac: { enabled: true } } }, runtime);
  assert.equal(e.boot(T0 + 5000).desired.awake, true);
  assert.deepEqual(e.state.session, runtime.session);
  e.tick(T0 + 10000, { ac: false });
  assert.equal(e.state.session, null);
  const disabled = engine({}, runtime);
  assert.equal(disabled.boot(T0 + 5000).desired.awake, false);
  assert.equal(disabled.state.session, null);
});

// ── Commands, settings edits and effects ─────────────────────────────────────────────────────────────────────────

test('closed-lid commands change settings; engine commands change nothing; unknown commands log once', () => {
  const e = engine();
  e.boot(T0);
  let out = e.command(T0, 'closed-lid:on');
  assert.equal(e.settings.closedLid.enabled, true);
  assert.deepEqual(out.effects.map((x) => x.type), ['settings']);
  out = e.command(T0, 'closed-lid:toggle');
  assert.equal(e.settings.closedLid.enabled, false);
  assert.deepEqual(e.command(T0, 'closed-lid:off').effects, []);
  for (const c of ['menu', 'refresh', 'install', 'uninstall']) assert.deepEqual(e.command(T0, c).effects, [], c);
  for (const c of ['bogus', 'mode:sleep', 'display:maybe', '', 42, { command: 'timer', value: 0 }]) {
    const bad = e.command(T0, c);
    assert.equal(bad.effects.length, 1, JSON.stringify(c));
    assert.equal(bad.effects[0].type, 'log');
  }
  assert.equal(e.state.session, null);
  assert.equal(e.command(T0, { command: 'mode', value: 'on' }).desired.awake, true);
});

test('a settings.mode edit made outside the engine applies on the next step', () => {
  const e = engine();
  e.boot(T0);
  e.edit({ mode: 'on' });
  assert.equal(e.tick(T0 + 10000).desired.awake, true);
  assert.deepEqual(sessionOf(e.state), ['on', 'user']);
  e.edit({ mode: 'off' });
  assert.equal(e.tick(T0 + 20000).desired.awake, false);
  assert.equal(e.state.trigger.suppressed, true, 'an Off on AC is a user Off');
  e.edit({ mode: 'timer' });
  const out = e.tick(T0 + 30000);
  assert.equal(e.state.session, null, 'no minutes to start a timer from');
  assert.ok(out.effects.some((x) => x.type === 'settings' && x.settings.mode === 'off'));
  assert.equal(e.settings.mode, 'off');
});

test('a runtime effect only when the session or the trigger state changes', () => {
  const e = engine();
  e.boot(T0);
  assert.deepEqual(e.tick(T0 + 10000).effects, []);
  const on = e.command(T0 + 20000, 'mode:on');
  assert.deepEqual(on.effects.map((x) => x.type), ['settings', 'runtime']);
  assert.deepEqual(on.effects[1].session, { mode: 'on', origin: 'user', startedAt: T0 + 20000, endsAt: null });
  assert.deepEqual(on.effects[1].trigger, { suppressed: false, lastAc: true });
  assert.deepEqual(e.tick(T0 + 30000).effects, []);
});
