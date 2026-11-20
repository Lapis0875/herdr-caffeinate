// Names, C2 settings and runtime normalization, C1 command parsing and the C3 shared state shape (node T1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS, HELPER_PATH, PLIST_PATH, SHARED_KEY, SUDOERS_PATH, WATCHDOG_DIR, applyFake, buildShared, claimPath,
  defaultSettings, enginePath, normalizeRuntime, normalizeSettings, parseCommand, parseSettings, runtimePath,
  sameShared, serializeSettings, settingsPath, statePath, toRuntime,
} from '../mods/herdr-caffeinate/core/state.js';
import { initialState } from '../mods/herdr-caffeinate/core/machine.js';

const T0 = 1763568000000;
const INSTALLED = { sudo: true, failsafe: true };

test('names and paths follow C2, C3 and C4', () => {
  assert.equal(SHARED_KEY, 'herdr-caffeinate.state');
  const home = '/Users/u/.config/herdr-app';
  assert.equal(settingsPath(home), '/Users/u/.config/herdr-app/data/herdr-caffeinate/settings.json');
  assert.equal(runtimePath(`${home}/`), '/Users/u/.config/herdr-app/data/herdr-caffeinate/runtime.json');
  assert.equal(statePath(home), '/Users/u/.config/herdr-app/data/herdr-caffeinate/state.json');
  assert.equal(claimPath('/Users/u'), '/Users/u/.herdr/herdr-caffeinate/claim');
  assert.equal(enginePath('/Users/u/'), '/Users/u/.herdr/herdr-caffeinate/engine');
  assert.equal(SUDOERS_PATH, '/etc/sudoers.d/herdr-caffeinate');
  assert.equal(HELPER_PATH, '/Library/PrivilegedHelperTools/io.github.lapis0875.herdr-caffeinate.failsafe');
  assert.equal(PLIST_PATH, '/Library/LaunchDaemons/io.github.lapis0875.herdr-caffeinate.failsafe.plist');
  assert.equal(WATCHDOG_DIR, '/var/db/herdr-caffeinate');
});

test('default settings equal C2', () => {
  const expected = {
    version: 1, language: 'system', mode: 'off', display: false,
    timer: { presetsMin: [15, 60, 120], lastCustomMin: 45 },
    agent: { lingerSec: 30, includeRemote: false },
    closedLid: { enabled: false, acOnly: true, batteryFloor: 20 },
    trigger: { ac: { enabled: false, mode: 'on' } },
    debug: false,
  };
  assert.deepEqual(defaultSettings(), expected);
  for (const raw of [undefined, null, 'x', 3, [1], {}]) assert.deepEqual(normalizeSettings(raw), expected, JSON.stringify(raw));
  assert.notEqual(defaultSettings().timer.presetsMin, defaultSettings().timer.presetsMin);
});

test('settings keep unknown fields at every level', () => {
  const raw = {
    extra: { a: 1 }, language: 'ko', mode: 'on', display: true,
    timer: { presetsMin: [5], lastCustomMin: 90, note: 'x' },
    agent: { lingerSec: 60, includeRemote: true, z: 1 },
    closedLid: { enabled: true, acOnly: false, batteryFloor: 30, y: [1] },
    trigger: { ac: { enabled: true, mode: 'agent', w: true }, display: { enabled: true } },
    debug: true,
  };
  assert.deepEqual(normalizeSettings(raw), { version: 1, ...raw });
  assert.deepEqual(normalizeSettings({ mode: 'timer' }).mode, 'timer');
});

test('invalid settings fields fall back to their defaults', () => {
  const raw = {
    version: 7, language: 'fr', mode: 'sleep', display: 'yes',
    timer: { presetsMin: [0, 15], lastCustomMin: 1441 },
    agent: { lingerSec: -1, includeRemote: 1 },
    closedLid: { enabled: 'true', acOnly: null, batteryFloor: '30' },
    trigger: { ac: { enabled: 1, mode: 'timer' } },
    debug: 'no',
  };
  assert.deepEqual(normalizeSettings(raw), defaultSettings());
  assert.deepEqual(normalizeSettings({ timer: 'x', agent: [], closedLid: 1, trigger: { ac: 'on' } }), defaultSettings());
  for (const presetsMin of [[], [15.5], ['15'], [1441], [1, 2, 3, 4, 5, 6, 7, 8, 9], 15]) {
    assert.deepEqual(normalizeSettings({ timer: { presetsMin } }).timer.presetsMin, [15, 60, 120], JSON.stringify(presetsMin));
  }
  assert.deepEqual(normalizeSettings({ timer: { presetsMin: [1, 1440] } }).timer.presetsMin, [1, 1440]);
  for (const lingerSec of [3601, 1.5, '30', null]) assert.equal(normalizeSettings({ agent: { lingerSec } }).agent.lingerSec, 30);
  assert.equal(normalizeSettings({ agent: { lingerSec: 0 } }).agent.lingerSec, 0);
  assert.equal(normalizeSettings({ timer: { lastCustomMin: 0 } }).timer.lastCustomMin, 45);
});

test('batteryFloor clamps to 10..90', () => {
  const cases = [[5, 10], [10, 10], [20, 20], [90, 90], [95, 90], [-3, 10], [33.6, 34], [NaN, 20], ['30', 20], [null, 20]];
  for (const [value, expected] of cases) {
    assert.equal(normalizeSettings({ closedLid: { batteryFloor: value } }).closedLid.batteryFloor, expected, String(value));
  }
});

test('fake facts are normalized and override probe facts only with debug true', () => {
  const s = normalizeSettings({ debug: true, fake: { ac: false, percent: 19, thermal: 2, lidClosed: true, extra: 1 } });
  assert.deepEqual(s.fake, { ac: false, percent: 19, thermal: 2, lidClosed: true, extra: 1 });
  assert.deepEqual(normalizeSettings({ fake: { ac: 'no', percent: 19.5, thermal: 4, lidClosed: 1 } }).fake, {});
  assert.equal('fake' in normalizeSettings({ fake: 3 }), false);
  assert.equal(normalizeSettings({ fake: { percent: 150 } }).fake.percent, 100);
  const facts = { ac: true, percent: 100, thermal: 0, lidClosed: false, lidCausesSleep: true, sleepDisabled: false };
  assert.deepEqual(applyFake(facts, s), { ...facts, ac: false, percent: 19, thermal: 2, lidClosed: true });
  assert.equal(applyFake(facts, { ...s, debug: false }), facts);
  assert.equal(applyFake(facts, normalizeSettings({ debug: true })), facts);
  assert.deepEqual(applyFake(facts, normalizeSettings({ debug: true, fake: { percent: 24 } })), { ...facts, percent: 24 });
});

test('parseSettings reads settings.json text and refuses text that is not a JSON object', () => {
  assert.deepEqual(parseSettings('{'), { ok: false, settings: defaultSettings() });
  assert.deepEqual(parseSettings('[]'), { ok: false, settings: defaultSettings() });
  assert.deepEqual(parseSettings('{"mode":"on"}'), { ok: true, settings: { ...defaultSettings(), mode: 'on' } });
  const s = normalizeSettings({ mode: 'agent', x: 1, closedLid: { batteryFloor: 35 } });
  const text = serializeSettings(s);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(parseSettings(text), { ok: true, settings: s });
});

test('runtime.json normalizes; anything invalid reads as nothing recorded', () => {
  const good = {
    v: 1,
    session: { mode: 'timer', origin: 'user', startedAt: T0, endsAt: T0 + 60000 },
    holder: { pid: 123, argv: ['/usr/bin/caffeinate', '-i', '-s', '-w', '77'], appPid: 77 },
    keeper: { pid: 124, argv: ['/bin/sh', 'keeper.sh'] },
    trigger: { suppressed: true, lastAc: false },
    lastMode: 'agent',
  };
  assert.deepEqual(normalizeRuntime(good), good);
  const empty = { v: 1, session: null, holder: null, keeper: null, trigger: { suppressed: false, lastAc: null }, lastMode: null };
  for (const bad of [null, 'x', {}, { ...good, v: 2 }]) assert.deepEqual(normalizeRuntime(bad), empty, JSON.stringify(bad));
  const sessionOf = (session) => normalizeRuntime({ v: 1, session }).session;
  assert.equal(sessionOf({ mode: 'timer', origin: 'user', startedAt: T0 }), null);
  assert.equal(sessionOf({ mode: 'timer', origin: 'trigger', startedAt: T0, endsAt: T0 }), null);
  assert.equal(sessionOf({ mode: 'off', origin: 'user', startedAt: T0 }), null);
  assert.equal(sessionOf({ mode: 'on', origin: 'boss', startedAt: T0 }), null);
  assert.equal(sessionOf({ mode: 'on', origin: 'user' }), null);
  assert.deepEqual(sessionOf({ mode: 'on', origin: 'trigger', startedAt: T0, endsAt: 5 }), { mode: 'on', origin: 'trigger', startedAt: T0, endsAt: null });
  assert.equal(normalizeRuntime({ v: 1, holder: { pid: 0, argv: ['x'], appPid: 1 } }).holder, null);
  assert.equal(normalizeRuntime({ v: 1, holder: { pid: 5, argv: [], appPid: 1 } }).holder, null);
  assert.equal(normalizeRuntime({ v: 1, holder: { pid: 5, argv: ['x'] } }).holder, null);
  assert.equal(normalizeRuntime({ v: 1, keeper: { pid: 5, argv: [1] } }).keeper, null);
  assert.deepEqual(normalizeRuntime({ v: 1, trigger: { suppressed: 'yes', lastAc: 1 } }).trigger, { suppressed: false, lastAc: null });
  for (const lastMode of ['timer', 'off', 'AGENT', 1, null]) assert.equal(normalizeRuntime({ v: 1, lastMode }).lastMode, null, String(lastMode));
  assert.deepEqual(toRuntime(initialState(good), good.holder, good.keeper), good);
  // Nothing recorded: toggle turns On.
  assert.deepEqual(toRuntime(initialState(null)), { ...empty, lastMode: 'on' });
});

test('parseCommand accepts every C1 command and rejects malformed ones', () => {
  assert.deepEqual(parseCommand('toggle'), { command: 'toggle', value: null });
  for (const mode of ['off', 'on', 'agent']) assert.deepEqual(parseCommand(`mode:${mode}`), { command: 'mode', value: mode });
  assert.deepEqual(parseCommand('timer:1'), { command: 'timer', value: 1 });
  assert.deepEqual(parseCommand('timer:1440'), { command: 'timer', value: 1440 });
  assert.deepEqual(parseCommand('timer:cancel'), { command: 'timer', value: 'cancel' });
  for (const head of ['display', 'closed-lid']) {
    for (const value of ['on', 'off', 'toggle']) assert.deepEqual(parseCommand(`${head}:${value}`), { command: head, value });
  }
  for (const name of ['menu', 'refresh', 'install', 'uninstall']) assert.deepEqual(parseCommand(name), { command: name, value: null });
  assert.deepEqual(parseCommand('herdr-caffeinate.timer:15'), { command: 'timer', value: 15 });
  for (const name of COMMANDS) assert.notEqual(parseCommand(name), null, name);
  const bad = ['timer:0', 'timer:1441', 'timer:abc', 'timer:', 'timer:1.5', 'timer:01', 'timer:-5', 'timer:+5', 'timer: 5',
    'timer:5 ', 'timer:99999', 'mode:timer', 'mode:', 'display:yes', 'closed-lid', 'lid:on', 'Toggle', 'toggle:x', '',
    'other-mod.toggle', null, undefined, 15];
  for (const text of bad) assert.equal(parseCommand(text), null, String(text));
});

test('buildShared gives the C3 shape', () => {
  assert.deepEqual(buildShared(initialState(null), undefined, T0), {
    v: 1, at: T0, mode: 'off', active: false, reason: null, display: false, endsAt: null,
    closedLid: { wanted: false, status: 'off', blocked: null }, install: { sudo: false, failsafe: false },
  });
  const on = { mode: 'on', origin: 'user', startedAt: T0, endsAt: null };
  const agent = { mode: 'agent', origin: 'user', startedAt: T0, endsAt: null };
  const timer = { mode: 'timer', origin: 'user', startedAt: T0, endsAt: T0 + 60000 };
  const state = (session, extra = {}) => ({ ...initialState(null), session, awake: true, ...extra });
  const view = (s) => [s.mode, s.active, s.reason, s.endsAt];
  assert.deepEqual(view(buildShared(state(on), INSTALLED, T0)), ['on', true, 'user', null]);
  assert.deepEqual(view(buildShared(state(agent), INSTALLED, T0)), ['agent', true, 'agent', null]);
  assert.deepEqual(view(buildShared(state(agent, { awake: false }), INSTALLED, T0)), ['agent', false, null, null]);
  assert.deepEqual(view(buildShared(state(timer), INSTALLED, T0)), ['timer', true, 'timer', T0 + 60000]);
  assert.deepEqual(view(buildShared(state({ ...on, origin: 'trigger' }), INSTALLED, T0)), ['on', true, 'trigger', null]);
  assert.deepEqual(view(buildShared(state({ ...agent, origin: 'trigger' }), INSTALLED, T0)), ['agent', true, 'trigger', null]);
  assert.equal(buildShared(state(on, { display: true }), INSTALLED, T0).display, true);
  assert.equal(buildShared(state(on, { awake: false, display: true }), INSTALLED, T0).display, false);
  const lid = (closedLid) => buildShared(state(on, { closedLid }), INSTALLED, T0).closedLid;
  assert.deepEqual(lid({ wanted: true, status: 'blocked', blocked: 'battery', engaged: false }), { wanted: true, status: 'blocked', blocked: 'battery' });
  assert.deepEqual(lid({ wanted: true, status: 'engaged', blocked: null, engaged: true }), { wanted: true, status: 'engaged', blocked: null });
  assert.deepEqual(lid({ wanted: true, status: 'external', blocked: 'thermal', engaged: false }), { wanted: true, status: 'external', blocked: null });
  assert.deepEqual(buildShared(state(on), INSTALLED, T0).install, INSTALLED);
});

test('sameShared ignores only at', () => {
  const s = { ...initialState(null), session: { mode: 'on', origin: 'user', startedAt: T0, endsAt: null }, awake: true };
  const a = buildShared(s, INSTALLED, T0);
  const b = buildShared(s, INSTALLED, T0 + 10000);
  assert.ok(sameShared(a, b));
  assert.ok(!sameShared(a, { ...b, active: false }));
  assert.ok(!sameShared(a, buildShared(s, { sudo: true, failsafe: false }, T0)));
  assert.ok(!sameShared(a, null));
});
