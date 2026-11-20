// Engine reconcile (node T5, C11) against a fake Mac: processes and `ps`/`kill`, `pmset -a disablesleep` through
// `sudo -n`, the claim file, the probe, the app-home files with writeTextFile's `expected`, a virtual clock and
// Herdr's call model (S2, F2): every dispatch (a copy's init, a timer, a command delivery, a host call's result) sets
// the call running now; host calls and owner-less timers made during it belong to that copy, and a closed copy's
// pending timers and call results are never delivered. The engine runs through its public API only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_WINDOW_MS, COPY_CHECK_MS, Engine, KEEP_OPEN, POKE_MS, STALL_MS, TICK_MS } from '../mods/herdr-caffeinate/sys/engine.js';
import { DETACH, HERDR_PID, WAIT_GONE } from '../mods/herdr-caffeinate/sys/holder.js';
import { WRITE_CLAIM } from '../mods/herdr-caffeinate/sys/closed-lid.js';
import { SLEEP_DISABLED_SH, probeScript } from '../mods/herdr-caffeinate/sys/probe.js';
import { workingAgents } from '../mods/herdr-caffeinate/sys/agents.js';
import {
  SHARED_KEY, claimPath, defaultSettings, runtimePath, serializeSettings, settingsPath, statePath,
} from '../mods/herdr-caffeinate/core/state.js';
import { translate } from '../mods/herdr-caffeinate/core/i18n.js';

const T0 = 1795110000000;
const HOME = '/Users/me';
const APP = '/Users/me/.config/herdr-app';
const HERDR = 56192;
const HERDR_COMMAND = '/Applications/Herdr.app/Contents/MacOS/Herdr';
const HOLDER = `/usr/bin/caffeinate -i -s -w ${HERDR}`;
const CLAIM = claimPath(HOME);

// Microtasks drain fully before each setImmediate; every fake host result arrives through the clock.
const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') merge(target[key], value);
    else target[key] = value;
  }
  return target;
}

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────

class Clock {
  constructor(t) {
    this.t = t;
    this.timers = [];
    // The copy whose call runs now (null: none) and the copies that closed.
    this.current = null;
    this.closed = new Set();
  }

  live(ctx) {
    return ctx === null || !this.closed.has(ctx);
  }

  schedule(ms, fn, ctx = this.current) {
    const timer = { at: this.t + Math.max(0, ms), fn, ctx, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  due(end) {
    this.timers = this.timers.filter((x) => !x.cancelled && this.live(x.ctx));
    return this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
  }

  fire(timer) {
    this.timers.splice(this.timers.indexOf(timer), 1);
    this.t = Math.max(this.t, timer.at);
    this.current = timer.ctx;
    timer.fn();
  }

  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await settle();
      const timer = this.due(end);
      if (!timer) break;
      this.fire(timer);
    }
    this.t = end;
    await settle();
  }

  /** Fires the next timer, whenever it is due; false when none is left. */
  async next() {
    await settle();
    const timer = this.due(Infinity);
    if (!timer) return false;
    this.fire(timer);
    await settle();
    return true;
  }
}

// A cx whose members belong to `ownerOf()`. An `owner: null` timer or task hands its callback `floating`: a cx whose
// members belong to the call running when they are used (AsyncContext), while the timer itself belongs to the copy
// that made it (S2: it stops when that copy closes).
function makeCx(clock, ownerOf, floating = null) {
  const cx = {
    sleep: (ms) => new Promise((resolve) => clock.schedule(ms, resolve, ownerOf())),
    spawn(body, opts) {
      const into = opts?.owner === null ? floating ?? cx : cx;
      Promise.resolve().then(() => body(into)).catch(() => {});
      return { cancel() {}, is_done: () => false };
    },
    timer: {
      after(ms, fn, opts) {
        const into = opts?.owner === null ? floating ?? cx : cx;
        const timer = clock.schedule(ms, () => fn(into), ownerOf());
        return { cancel: () => (timer.cancelled = true) };
      },
      every(ms, fn, opts) {
        const into = opts?.owner === null ? floating ?? cx : cx;
        const ctx = ownerOf();
        let timer;
        const arm = () => {
          timer = clock.schedule(ms, () => {
            fn(into);
            arm();
          }, ctx);
        };
        arm();
        return { cancel: () => (timer.cancelled = true) };
      },
    },
  };
  return cx;
}

/** A copy's own cx (init, render, its default-owner timers). */
const copyCx = (clock, ctx) => makeCx(clock, () => ctx, makeCx(clock, () => clock.current));

class FakeMac {
  constructor(clock) {
    this.clock = clock;
    this.procs = new Map([[1, '/sbin/launchd'], [HERDR, HERDR_COMMAND]]);
    this.nextPid = 3000;
    this.sleepDisabled = 0;
    this.sudo = true; // our sudoers rule is installed
    this.aliveAge = 5; // seconds since the watchdog's last run; null: no daemon
    this.ac = true;
    this.percent = 100;
    this.lidClosed = false;
    this.causesSleep = true;
    this.thermal = 0;
    this.lastRestore = null; // epoch seconds
    this.pmsetSticks = true; // false: `pmset -a disablesleep` exits 0 and changes nothing
    this.files = new Map(); // path → {text, mtime (ms)}
    this.calls = [];
    this.terminals = [];
    // Host calls run now (their effects happen) and deliver their result to the calling copy later, or never once it
    // closed. `hang(command, args)` true: that call never answers.
    this.hang = () => false;
    this.readTextFile = (path) => this.deliver(() => this.files.get(path)?.text ?? null);
    this.writeTextFile = (path, text, expected) => this.deliver(() => {
      if ((this.files.get(path)?.text ?? null) !== expected) throw new Error('stale snapshot');
      this.files.set(path, { text, mtime: this.clock.t });
      return null;
    });
    this.mkdir = () => this.deliver(() => undefined);
  }

  deliver(compute) {
    let result;
    let error = null;
    try {
      result = compute();
    } catch (e) {
      error = e;
    }
    return new Promise((resolve, reject) => this.clock.schedule(0, () => (error ? reject(error) : resolve(result))));
  }

  get nowSec() {
    return Math.floor(this.clock.t / 1000);
  }

  holders() {
    return [...this.procs].filter(([, command]) => command.startsWith('/usr/bin/caffeinate'));
  }

  exec(command, args = []) {
    this.calls.push({ at: this.clock.t, argv: [command, ...args] });
    if (this.hang(command, args)) return new Promise(() => {});
    return this.deliver(() => this.run(command, args));
  }

  run(command, args) {
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    const fail = () => ({ code: 1, stdout: '', stderr: 'failed' });
    if (command === '/bin/sh' && args[0] === '-c') {
      const script = args[1];
      if (script === HERDR_PID) return ok(`${HERDR}\n${HERDR_COMMAND}\n`);
      if (script === DETACH) {
        const pid = this.nextPid++;
        this.procs.set(pid, args.slice(3).join(' '));
        return ok(`${pid}\n`);
      }
      if (script === SLEEP_DISABLED_SH) return ok(` SleepDisabled\t\t${this.sleepDisabled}\n`);
      if (script === WRITE_CLAIM) {
        this.files.set(args[4], { text: `${args[5]}\n`, mtime: this.clock.t });
        return ok();
      }
      if (script === WAIT_GONE) return this.procs.has(Number(args[3])) ? { code: 1, stdout: '', stderr: '' } : ok();
      throw new Error(`unexpected script ${script}`);
    }
    if (command === '/bin/sh' && args[0] === probeScript(APP)) return ok(this.probeText(args.includes('--thermal')));
    if (command === '/bin/ps' && args[0] === '-o') {
      const found = this.procs.get(Number(args[3]));
      return found ? ok(`${found}\n`) : fail();
    }
    if (command === '/bin/ps' && args[0] === '-axo') {
      return ok(`${[...this.procs].map(([pid, c]) => `${String(pid).padStart(5)} ${c}`).join('\n')}\n`);
    }
    if (command === '/bin/kill') return this.procs.delete(Number(args[0])) ? ok() : fail();
    if (command === '/usr/bin/sudo') {
      if (!this.sudo) return fail();
      if (args[1] === '-l') return ok(`/usr/bin/pmset -a disablesleep ${args.at(-1)}\n`);
      if (this.pmsetSticks) this.sleepDisabled = Number(args.at(-1));
      return ok();
    }
    if (command === '/usr/bin/touch') {
      const file = this.files.get(args[1]);
      if (file) file.mtime = this.clock.t;
      return ok();
    }
    if (command === '/bin/rm') {
      this.files.delete(args[1]);
      return ok();
    }
    if (command === '/usr/bin/pmset' && args[0] === 'sleepnow') return ok();
    if (command === '/usr/bin/defaults') return ok('(\n    "en-KR"\n)\n');
    throw new Error(`unexpected exec ${command} ${args.join(' ')}`);
  }

  probeText(thermal) {
    const claim = this.files.get(CLAIM);
    const lines = [
      '@@batt',
      `Now drawing from '${this.ac ? 'AC Power' : 'Battery Power'}'`,
      ` -InternalBattery-0 (id=23724131)\t${this.percent}%; ${this.ac ? 'charged' : 'discharging'}; 0:00 remaining present: true`,
      '@@pmset',
      ` SleepDisabled\t\t${this.sleepDisabled}`,
      '@@lid',
      `      "AppleClamshellCausesSleep" = ${this.causesSleep ? 'Yes' : 'No'}`,
      `      "AppleClamshellState" = ${this.lidClosed ? 'Yes' : 'No'}`,
    ];
    if (thermal) lines.push('@@thermal', String(this.thermal));
    lines.push(
      '@@stat',
      `alive=${this.aliveAge === null ? '' : this.nowSec - this.aliveAge}`,
      `claim=${claim ? Math.floor(claim.mtime / 1000) : ''}`,
      `restore=${this.lastRestore ?? ''}`,
      `now=${this.nowSec}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

// What an exec call did, for order checks.
function label({ argv }) {
  const [command, ...args] = argv;
  if (command === '/bin/sh' && args[0] === '-c') {
    return { [HERDR_PID]: 'herdr-pid', [DETACH]: 'launch', [SLEEP_DISABLED_SH]: 'readback', [WRITE_CLAIM]: 'claim:write', [WAIT_GONE]: 'wait-gone' }[args[1]] ?? 'sh';
  }
  if (command === '/bin/sh') return 'probe';
  if (command === '/bin/ps') return args[0] === '-axo' ? 'ps:all' : `ps:${args[3]}`;
  if (command === '/bin/kill') return `kill:${args[0]}`;
  if (command === '/usr/bin/sudo') return args[1] === '-l' ? 'sudo:list' : `pmset:${args.at(-1)}`;
  if (command === '/usr/bin/touch') return 'claim:touch';
  if (command === '/bin/rm') return 'claim:rm';
  if (command === '/usr/bin/pmset') return args[0];
  if (command === '/usr/bin/defaults') return 'locale';
  return command;
}

const LID = new Set(['readback', 'claim:write', 'pmset:0', 'pmset:1', 'claim:rm', 'sleepnow']);

function world({ settings = null, runtime = null, checking = false, mac = null, clock = null } = {}) {
  const c = clock ?? new Clock(T0);
  const m = mac ?? new FakeMac(c);
  if (settings) m.files.set(settingsPath(APP), { text: serializeSettings(merge(defaultSettings(), settings)), mtime: c.t });
  if (runtime) m.files.set(runtimePath(APP), { text: JSON.stringify(runtime), mtime: c.t });
  const w = { clock: c, mac: m, shared: [], toasts: [], logs: [], tabs: [], menus: [] };
  w.engine = new Engine({
    exec: (command, args, opts) => m.exec(command, args, opts),
    readTextFile: m.readTextFile,
    writeTextFile: m.writeTextFile,
    mkdir: m.mkdir,
    terminals: () => m.terminals,
    setShared: (key, value) => w.shared.push([key, value]),
    notify: (n) => w.toasts.push(n),
    runCommand: (name, args) => w.tabs.push([name, args]),
    checking: () => checking,
    appHome: () => APP,
    home: () => HOME,
    now: () => c.t,
    log: (message) => w.logs.push(message),
    openMenu: () => w.menus.push(c.t),
  });
  // A copy: its init runs in its own call. `cx.close()` alone models a reload (the build's calls stop, no close()).
  w.attach = async (role = 'host') => {
    c.copies = (c.copies ?? 0) + 1;
    const ctx = `copy-${c.copies}`;
    const cx = copyCx(c, ctx);
    cx.close = () => c.closed.add(ctx);
    c.current = ctx;
    const copy = w.engine.attach(role, cx);
    await c.advance(0);
    return { copy, cx, ctx, role };
  };
  /** Runs `fn` in `copy`'s call (a click, a render, a command delivery). */
  w.within = (copy, fn) => {
    c.current = copy.ctx;
    return fn();
  };
  w.close = (copy) => {
    w.within(copy, () => w.engine.detach(copy.copy));
    copy.cx.close();
  };
  /** Fires timers until `promise` settles (at most 2 min of clock time); its value, or undefined when it never did. */
  w.until = async (promise) => {
    let settled = false;
    promise.then(() => (settled = true), () => (settled = true));
    const start = c.t;
    await settle();
    while (!settled && c.t - start <= 120000 && (await c.next()));
    return settled ? promise : undefined;
  };
  /** Delivers a command to `copy` (its nextCommand) and runs the clock until that delivery is handled. */
  w.cmd = (copy, text) => w.until(w.within(copy, () => w.engine.command(copy.copy, text)));
  w.c3 = () => JSON.parse(m.files.get(statePath(APP)).text);
  w.settings = () => JSON.parse(m.files.get(settingsPath(APP)).text);
  w.runtime = () => JSON.parse(m.files.get(runtimePath(APP)).text);
  w.edit = (patch) => {
    const path = settingsPath(APP);
    m.files.set(path, { text: serializeSettings(merge(JSON.parse(m.files.get(path).text), patch)), mtime: c.t });
  };
  w.mark = () => m.calls.length;
  w.labels = (from = 0) => m.calls.slice(from).map(label);
  return w;
}

const holderCommands = (w) => w.mac.holders().map(([, command]) => command);

// ── Holder ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('mode On holds exactly one holder; the display toggle replaces it; Off leaves none', async () => {
  const w = world();
  const host = await w.attach('host');
  assert.equal(w.engine.running(), true);
  assert.deepEqual(holderCommands(w), []);
  assert.equal(w.c3().active, false);

  await w.cmd(host, 'mode:on');
  assert.deepEqual(holderCommands(w), [HOLDER]);
  assert.equal(w.c3().active, true);
  const [[first]] = w.mac.holders();

  await w.cmd(host, 'display:on');
  assert.deepEqual(holderCommands(w), [`/usr/bin/caffeinate -i -s -d -w ${HERDR}`]);
  assert.equal(w.mac.procs.has(first), false);
  assert.equal(w.c3().display, true);

  // Ticks, pokes and repeated commands never add a second holder.
  for (let i = 0; i < 3; i += 1) {
    w.engine.poke();
    await w.clock.advance(31000);
    await w.cmd(host, 'mode:on');
  }
  assert.equal(w.mac.holders().length, 1);

  await w.cmd(host, 'display:off');
  assert.deepEqual(holderCommands(w), [HOLDER]);
  await w.cmd(host, 'mode:off');
  assert.deepEqual(holderCommands(w), []);
  assert.equal(w.c3().active, false);
  assert.equal(w.runtime().holder, null);
  // A user Off on AC suppresses the AC trigger; the views read it from the snapshot.
  assert.deepEqual(w.engine.snapshot().trigger, { suppressed: true, lastAc: true });
});

test('a holder that ended outside Herdr is started again on the next probe', async () => {
  const w = world({ settings: { mode: 'on' } });
  await w.attach('host');
  const [[pid]] = w.mac.holders();
  w.mac.procs.delete(pid);
  await w.clock.advance(30000);
  assert.equal(w.mac.holders().length, 1);
  assert.notEqual(w.mac.holders()[0][0], pid);
});

test('orphan holders of this Herdr pid are killed at boot after their argv is checked; nothing else is', async () => {
  const w = world();
  w.mac.procs.set(4001, HOLDER);
  w.mac.procs.set(4002, `/usr/bin/caffeinate -i -s -d -w ${HERDR} -t 300`);
  w.mac.procs.set(4003, '/usr/bin/caffeinate -i -s -w 777');
  w.mac.procs.set(4004, `/usr/bin/caffeinate -i -s -w ${HERDR} -u`);
  w.mac.procs.set(4005, '/bin/zsh');
  // An orphan caught before nohup exec'd caffeinate (S1 fact 2).
  w.mac.procs.set(4006, `nohup ${HOLDER}`);
  await w.attach('host');
  assert.deepEqual([...w.mac.procs.keys()].filter((pid) => pid > 4000 && pid < 5000).sort(), [4003, 4004, 4005]);
  const labels = w.labels();
  for (const pid of [4001, 4002, 4006]) {
    const kill = labels.indexOf(`kill:${pid}`);
    assert.ok(kill > 0 && labels[kill - 1] === `ps:${pid}`, `ps -o command= -p ${pid} right before its kill`);
  }
  assert.ok(!labels.includes('kill:4003') && !labels.includes('kill:4004') && !labels.includes('kill:4005'));
});

test('after a reload the holder is adopted from runtime.json, never doubled', async () => {
  const clock = new Clock(T0);
  const a = world({ clock });
  const hostA = await a.attach('host');
  await a.cmd(hostA, 'mode:on');
  const [[pid]] = a.mac.holders();
  assert.equal(a.runtime().holder.pid, pid);

  // Saving main.js: the old build's copies die, a new build's engine boots from the same files.
  hostA.cx.close();
  const b = world({ clock, mac: a.mac });
  const from = b.mark();
  await b.attach('host');
  assert.deepEqual(b.mac.holders().map(([p]) => p), [pid]);
  assert.ok(!b.labels(from).includes('launch'), 'no second launch');
  assert.ok(b.labels(from).includes(`ps:${pid}`), 'argv checked before adoption');
  assert.equal(b.runtime().holder.pid, pid);
  assert.equal(b.c3().active, true);
});

test('a recorded holder whose pid now runs something else is neither adopted nor killed', async () => {
  const clock = new Clock(T0);
  const a = world({ clock, settings: { mode: 'on' } });
  const hostA = await a.attach('host');
  const [[pid]] = a.mac.holders();
  hostA.cx.close();
  a.mac.procs.set(pid, '/bin/zsh -l');

  const b = world({ clock, mac: a.mac });
  const from = b.mark();
  await b.attach('host');
  assert.equal(b.mac.procs.get(pid), '/bin/zsh -l');
  assert.ok(!b.labels(from).includes(`kill:${pid}`));
  assert.deepEqual(holderCommands(b), [HOLDER]);
  assert.notEqual(b.runtime().holder.pid, pid);
});

test('kill only on pid + argv match: a holder pid reused by another program is left alone', async () => {
  const w = world();
  const host = await w.attach('host');
  await w.cmd(host, 'mode:on');
  const [[pid]] = w.mac.holders();
  w.mac.procs.set(pid, '/usr/bin/vim notes.txt');
  const from = w.mark();
  await w.cmd(host, 'mode:off');
  assert.ok(w.labels(from).includes(`ps:${pid}`));
  assert.ok(!w.labels(from).includes(`kill:${pid}`));
  assert.equal(w.mac.procs.get(pid), '/usr/bin/vim notes.txt');
  assert.equal(w.runtime().holder, null);
});

test('timer holders carry -t <seconds left>, survive a reload and end at endsAt', async () => {
  const clock = new Clock(T0);
  const a = world({ clock });
  const hostA = await a.attach('host');
  await a.cmd(hostA, 'timer:15');
  assert.deepEqual(holderCommands(a), [`${HOLDER} -t 900`]);
  assert.equal(a.c3().endsAt, a.clock.t + 15 * 60000, 'ends 15 min after the command was handled');

  // A new timer replaces the holder with the new seconds.
  await a.clock.advance(60000);
  await a.cmd(hostA, 'timer:60');
  assert.deepEqual(holderCommands(a), [`${HOLDER} -t 3600`]);
  const endsAt = a.c3().endsAt;
  assert.equal(endsAt, a.clock.t + 60 * 60000);

  // Reload 10 min later: adopted as it is.
  await a.clock.advance(10 * 60000);
  hostA.cx.close();
  const b = world({ clock, mac: a.mac });
  const from = b.mark();
  await b.attach('host');
  assert.ok(!b.labels(from).includes('launch'));
  assert.deepEqual(holderCommands(b), [`${HOLDER} -t 3600`]);

  // The holder died while no engine ran: the new one gets the seconds left.
  const [[pid]] = b.mac.holders();
  b.mac.procs.delete(pid);
  await b.clock.advance(30000);
  const left = Math.ceil((endsAt - b.clock.t) / 1000);
  assert.deepEqual(holderCommands(b), [`${HOLDER} -t ${left}`]);

  // At endsAt the mode becomes Off and the holder goes.
  await b.clock.advance(endsAt - b.clock.t);
  assert.deepEqual(holderCommands(b), []);
  assert.equal(b.c3().mode, 'off');
  assert.equal(b.settings().mode, 'off');
});

test('agent mode holds while a local agent works and releases lingerSec after it stops', async () => {
  const w = world({ settings: { mode: 'agent' } });
  await w.attach('host');
  assert.deepEqual(holderCommands(w), []);

  // A remote agent alone does not count.
  w.mac.terminals = [{ address: 'vps/t2', status: 'working', state: 'live' }];
  w.engine.poke();
  await w.clock.advance(POKE_MS);
  assert.deepEqual(holderCommands(w), []);

  w.mac.terminals = [{ address: 't1', status: 'working', state: 'live' }, { address: 'vps/t2', status: 'working', state: 'live' }];
  w.engine.poke();
  await w.clock.advance(POKE_MS);
  assert.deepEqual(holderCommands(w), [HOLDER]);
  assert.equal(w.c3().reason, 'agent');

  await w.clock.advance(45000);
  w.mac.terminals = [{ address: 't1', status: 'done', state: 'live' }];
  w.engine.poke();
  await w.clock.advance(POKE_MS);
  await w.clock.advance(29000);
  assert.deepEqual(holderCommands(w), [HOLDER], 'lingering');
  await w.clock.advance(2000);
  assert.deepEqual(holderCommands(w), []);
  assert.equal(w.c3().active, false);
});

test('workingAgents counts live working terminals, local unless includeRemote', () => {
  const list = [
    { address: 't1', status: 'working', state: 'live' },
    { address: 't2', status: 'working', state: 'exited' },
    { address: 't3', status: 'idle', state: 'live' },
    { address: 'vps/t4', status: 'working', state: 'live' },
  ];
  assert.equal(workingAgents(list, false), 1);
  assert.equal(workingAgents(list, true), 2);
  assert.equal(workingAgents(null), 0);
});

// ── Lifetime ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('the engine stops when its starting copy closes, releasing nothing, and the next host/chip copy restarts it', async () => {
  const w = world({ settings: { mode: 'on' } });
  const menu = await w.attach('menu');
  assert.equal(w.engine.running(), false, 'a menu copy never starts the engine');
  assert.deepEqual(w.mac.calls, []);

  const host = await w.attach('host');
  assert.equal(w.engine.running(), true);
  const chip = await w.attach('chip');
  w.close(chip);
  assert.equal(w.engine.running(), true, 'another copy closing changes nothing');
  const [[pid]] = w.mac.holders();

  const from = w.mark();
  w.close(host);
  await w.clock.advance(120000);
  assert.equal(w.engine.running(), false);
  assert.deepEqual(w.labels(from), [], 'no kill, no pmset, no probe while stopped');
  assert.deepEqual(w.mac.holders().map(([p]) => p), [pid]);

  const sharedBefore = w.shared.length;
  const chip2 = await w.attach('chip');
  assert.equal(w.engine.running(), true);
  assert.deepEqual(w.mac.holders().map(([p]) => p), [pid], 'adopted again');
  assert.equal(w.shared.length, sharedBefore + 1, 'C3 republished at boot');
  assert.equal(w.shared.at(-1)[0], SHARED_KEY);
  assert.equal(w.shared.at(-1)[1].at, w.clock.t);
  w.close(menu);
  w.close(chip2);
});

test('a host copy restarts a stopped engine within its 5 s check (same-key replacement order)', async () => {
  const w = world();
  const old = await w.attach('host');
  const next = await w.attach('host');
  w.close(old);
  assert.equal(w.engine.running(), false);
  await w.clock.advance(5000);
  assert.equal(w.engine.running(), true);
  w.close(next);
});

test('nothing starts while checking()', async () => {
  const w = world({ checking: true, settings: { mode: 'on' } });
  await w.attach('host');
  await w.clock.advance(60000);
  assert.equal(w.engine.running(), false);
  assert.deepEqual(w.mac.calls, []);
});

test('F2: a menu copy that opens and closes mid-request never strands the engine; every command after a timer still changes C3', async () => {
  const w = world();
  const host = await w.attach('host');
  await w.cmd(host, 'timer:2');
  assert.equal(w.c3().mode, 'timer');
  const endsAt = w.c3().endsAt;

  // `menu` opens a menu copy: it asks for a probe and pokes the engine every second while it is open.
  await w.cmd(host, 'menu');
  const menu = await w.attach('menu');
  w.within(menu, () => w.engine.menu());
  menu.cx.timer.every(1000, () => w.engine.poke());
  await w.clock.advance(5000);
  // It closes right after asking for something (Install does; so does a quick close after `mod.open`).
  w.within(menu, () => w.engine.menu());
  w.close(menu);

  // The timer still ends at endsAt.
  await w.clock.advance(endsAt - w.clock.t + 500);
  assert.equal(w.c3().mode, 'off');
  assert.deepEqual(holderCommands(w), []);

  await w.cmd(host, 'mode:on');
  assert.equal(w.c3().active, true);
  assert.deepEqual(holderCommands(w), [HOLDER]);
  await w.cmd(host, 'display:on');
  assert.equal(w.c3().display, true);
  assert.deepEqual(holderCommands(w), [`/usr/bin/caffeinate -i -s -d -w ${HERDR}`]);
  await w.cmd(host, 'closed-lid:on');
  assert.equal(w.c3().closedLid.status, 'engaged');
  assert.equal(w.mac.sleepDisabled, 1);
  await w.cmd(host, 'timer:1440');
  assert.deepEqual([w.c3().mode, w.c3().endsAt], ['timer', w.clock.t + 1440 * 60000]);
  await w.cmd(host, 'closed-lid:off');
  assert.equal(w.c3().closedLid.status, 'off');
  await w.cmd(host, 'mode:off');
  assert.equal(w.c3().active, false);

  // The AC trigger with debug fakes: unplugged (clears the suppression the Off on AC set), then plugged in.
  w.edit({ debug: true, trigger: { ac: { enabled: true } }, fake: { ac: false } });
  await w.cmd(host, 'refresh');
  w.edit({ fake: { ac: true } });
  await w.clock.advance(TICK_MS);
  assert.deepEqual([w.c3().mode, w.c3().reason, w.c3().active], ['on', 'trigger', true]);
  assert.deepEqual(holderCommands(w), [`/usr/bin/caffeinate -i -s -d -w ${HERDR}`]);
});

test('a run stuck on a host call that never answers is replaced by the host check; its queued command still runs', async () => {
  const w = world();
  const host = await w.attach('host');
  let stuck = true;
  w.mac.hang = (command, args) => {
    if (!stuck || args[0] !== probeScript(APP)) return false;
    stuck = false;
    return true;
  };
  const done = w.within(host, () => w.engine.command(host.copy, 'mode:on'));
  await w.clock.advance(STALL_MS - 1000);
  assert.deepEqual(holderCommands(w), [], 'stuck in the probe');
  assert.equal(w.engine.running(), true);

  // The first check that finds it overdue only notes it (a system sleep looks the same); the next one replaces it.
  await w.clock.advance(1000 + 2 * COPY_CHECK_MS);
  assert.ok(w.logs.some((l) => l.includes('no progress')));
  assert.deepEqual(await w.until(done), { command: 'mode', value: 'on' });
  assert.deepEqual(holderCommands(w), [HOLDER]);
  assert.equal(w.c3().active, true);
});

test('D7: closed-lid ending with the lid shut stops the holder and waits until it is gone before pmset sleepnow; the lid opening after a sleep brings it back', async () => {
  const w = world({ settings: { mode: 'on', closedLid: { enabled: true, acOnly: false } } });
  w.mac.lidClosed = true;
  await w.attach('host');
  assert.equal(w.c3().closedLid.status, 'engaged');
  assert.deepEqual(holderCommands(w), [HOLDER], 'engaged: the mode holds the Mac awake with the lid shut');
  const [[pid]] = w.mac.holders();

  // The battery below the floor ends closed-lid with the lid shut (AT-21 run 2).
  w.mac.ac = false;
  w.mac.percent = 5;
  const from = w.mark();
  await w.clock.advance(TICK_MS);
  const steps = [`kill:${pid}`, 'wait-gone', 'pmset:0', 'claim:rm', 'sleepnow'];
  assert.deepEqual(w.labels(from).filter((l) => steps.includes(l)), steps);
  assert.deepEqual(holderCommands(w), []);
  assert.equal(w.mac.sleepDisabled, 0);
  assert.deepEqual(w.c3().closedLid, { wanted: true, status: 'blocked', blocked: 'battery' });
  assert.equal(w.c3().active, false);

  // While the lid stays shut nothing is held, sleepnow ran once, and the engine probes every 10 s.
  const shut = w.mark();
  await w.clock.advance(TICK_MS * 3);
  assert.ok(!w.labels(shut).includes('launch'));
  assert.ok(!w.labels(shut).includes('sleepnow'));
  assert.equal(w.labels(shut).filter((l) => l === 'probe').length, 3);

  // The Mac sleeps 10 min (every timer fires late), then wakes with the lid open: the overdue tick probes at once.
  w.clock.t += 10 * 60000;
  w.mac.lidClosed = false;
  await w.clock.advance(500);
  assert.deepEqual(holderCommands(w), [HOLDER]);
  assert.equal(w.c3().active, true);
  assert.equal(w.engine.running(), true);
  assert.ok(!w.logs.some((l) => l.includes('no progress')), 'a system sleep is not a stuck run');
});

test('debug fake lidClosed with closed-lid off: no holder while the lid reads shut, the holder back once it reads open; no sleepnow', async () => {
  const w = world({ settings: { mode: 'on', debug: true, fake: { lidClosed: true } } });
  await w.attach('host');
  assert.deepEqual(holderCommands(w), []);
  assert.equal(w.c3().active, false);
  w.edit({ fake: { lidClosed: false } });
  await w.clock.advance(TICK_MS);
  assert.deepEqual(holderCommands(w), [HOLDER]);
  assert.equal(w.c3().active, true);
  // Without debug the fake is ignored: the real lid (open) counts.
  w.edit({ debug: false, fake: { lidClosed: true } });
  await w.clock.advance(TICK_MS * 4);
  assert.deepEqual(holderCommands(w), [HOLDER]);
  assert.ok(!w.labels().includes('sleepnow'));
});

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('only the first-registered copy handles a command; one only a later copy got is handled once', async () => {
  const w = world();
  const host = await w.attach('host');
  const chip = await w.attach('chip');

  const fromChip = w.engine.command(chip.copy, 'display:toggle');
  const fromHost = w.engine.command(host.copy, 'display:toggle');
  await w.clock.advance(COMMAND_WINDOW_MS * 2);
  assert.equal(await fromChip, null);
  assert.deepEqual(await fromHost, { command: 'display', value: 'toggle' });
  assert.equal(w.settings().display, true, 'toggled once');

  await w.cmd(host, 'mode:on');
  await w.cmd(chip, 'mode:on');
  assert.equal(w.labels().filter((l) => l === 'launch').length, 1);

  // The first copy is not shown: the command reached the chip only.
  w.engine.command(chip.copy, 'mode:off');
  await w.clock.advance(COMMAND_WINDOW_MS);
  assert.deepEqual(holderCommands(w), []);

  // The menu's own clicks bypass the routing.
  const menu = await w.attach('menu');
  assert.deepEqual(await w.until(w.within(menu, () => w.engine.perform('mode:on'))), { command: 'mode', value: 'on' });
  assert.deepEqual(holderCommands(w), [`/usr/bin/caffeinate -i -s -d -w ${HERDR}`], 'display was toggled on above');
  w.close(menu);
});

test('refresh re-reads settings.json at once; ticks and pokes apply outside edits', async () => {
  const w = world();
  const host = await w.attach('host');
  w.edit({ mode: 'on' });
  await w.clock.advance(60000);
  assert.deepEqual(holderCommands(w), [], 'idle: no tick reads it');
  await w.cmd(host, 'refresh');
  assert.deepEqual(holderCommands(w), [HOLDER]);
  assert.equal(w.c3().mode, 'on');

  w.edit({ display: true });
  await w.clock.advance(30000);
  assert.deepEqual(holderCommands(w), [`/usr/bin/caffeinate -i -s -d -w ${HERDR}`], 'the next tick applies it');

  w.edit({ mode: 'off' });
  w.engine.poke();
  await w.clock.advance(POKE_MS);
  assert.deepEqual(holderCommands(w), []);
});

test('install and uninstall open a tab that runs the script and stays open; menu probes and opens the popover', async () => {
  const w = world();
  const host = await w.attach('host');
  await w.cmd(host, 'install');
  await w.cmd(host, 'uninstall');
  assert.deepEqual(w.tabs, [
    ['tab.new', { name: 'herdr-caffeinate install', argv: ['/bin/sh', '-c', KEEP_OPEN, 'sh', `${APP}/mods/herdr-caffeinate/bin/install.sh`] }],
    ['tab.new', { name: 'herdr-caffeinate uninstall', argv: ['/bin/sh', '-c', KEEP_OPEN, 'sh', `${APP}/mods/herdr-caffeinate/bin/uninstall.sh`] }],
  ]);

  const from = w.mark();
  await w.cmd(host, 'menu');
  assert.ok(w.labels(from).includes('probe'));
  assert.equal(w.menus.length, 1);

  await w.cmd(host, 'bogus:thing');
  assert.ok(w.logs.some((l) => l.includes('ignored command "bogus:thing"')));
});

test('C3 is published on change, never per tick, and state.json mirrors it', async () => {
  const w = world({ settings: { mode: 'on' } });
  await w.attach('host');
  const count = w.shared.length;
  await w.clock.advance(120000);
  assert.equal(w.shared.length, count);
  assert.deepEqual(w.c3(), w.shared.at(-1)[1]);
});

// ── Ticks ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('tick: none while idle, 30 s with a session, 10 s with debug', async () => {
  const w = world();
  const host = await w.attach('host');
  const probesFrom = (from) => w.mac.calls.slice(from).filter((c) => label(c) === 'probe').map((c) => c.at);
  const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);

  let from = w.mark();
  await w.clock.advance(65000);
  assert.deepEqual(probesFrom(from), [], 'idle');

  await w.cmd(host, 'mode:on');
  from = w.mark();
  await w.clock.advance(95000);
  assert.deepEqual(gaps(probesFrom(from)), [30000, 30000]);

  w.edit({ debug: true });
  await w.clock.advance(30000);
  from = w.mark();
  await w.clock.advance(60000);
  assert.deepEqual(gaps(probesFrom(from)), [TICK_MS, TICK_MS, TICK_MS, TICK_MS, TICK_MS]);

  await w.cmd(host, 'mode:off');
  await w.clock.advance(10000);
  from = w.mark();
  await w.clock.advance(40000);
  assert.equal(probesFrom(from).length, 4, 'debug keeps 10 s ticks with no session');
});

// ── Closed-lid ───────────────────────────────────────────────────────────────────────────────────────────────────

test('engage: read SleepDisabled, write the claim, sudo -n pmset 1, read back; ticks touch the claim', async () => {
  const w = world({ settings: { mode: 'on' } });
  const host = await w.attach('host');
  const from = w.mark();
  await w.cmd(host, 'closed-lid:on');
  assert.deepEqual(w.labels(from).filter((l) => LID.has(l)), ['readback', 'claim:write', 'pmset:1', 'readback']);
  assert.ok(w.labels(from).includes('sudo:list'), 'privilege checked for the command');
  assert.equal(w.mac.sleepDisabled, 1);
  const claim = JSON.parse(w.mac.files.get(CLAIM).text);
  assert.deepEqual(claim.owner, { pid: HERDR, appHome: APP });
  assert.equal(claim.v, 1);
  assert.deepEqual(w.c3().closedLid, { wanted: true, status: 'engaged', blocked: null });

  await w.clock.advance(TICK_MS);
  assert.equal(w.mac.files.get(CLAIM).mtime, w.clock.t, 'touched on the 10 s tick');
  await w.clock.advance(TICK_MS * 3);
  assert.equal(w.mac.files.get(CLAIM).mtime, w.clock.t);
});

test('disengage: sudo -n pmset 0, read back, remove the claim; sleepnow only with the lid closed and causing sleep', async () => {
  const w = world({ settings: { mode: 'on', closedLid: { enabled: true } } });
  const host = await w.attach('host');
  assert.equal(w.mac.sleepDisabled, 1);
  let from = w.mark();
  await w.cmd(host, 'closed-lid:off');
  assert.deepEqual(w.labels(from).filter((l) => LID.has(l)), ['pmset:0', 'readback', 'claim:rm']);
  assert.equal(w.mac.sleepDisabled, 0);
  assert.equal(w.mac.files.has(CLAIM), false);
  assert.deepEqual(w.c3().closedLid, { wanted: false, status: 'off', blocked: null });

  await w.cmd(host, 'closed-lid:on');
  w.mac.lidClosed = true;
  await w.clock.advance(TICK_MS);
  from = w.mark();
  await w.cmd(host, 'mode:off');
  assert.deepEqual(w.labels(from).filter((l) => LID.has(l)), ['pmset:0', 'readback', 'claim:rm', 'sleepnow']);
  assert.equal(w.mac.sleepDisabled, 0);
});

test('F4: after a disengage C3 shows the read-back (off, not external) through later steps; a foreign disablesleep 1 is still external', async () => {
  const w = world({ settings: { mode: 'on' } });
  const host = await w.attach('host');
  // Every publish re-renders each copy, and every render pokes the engine (a step with the last facts).
  const render = async () => {
    w.engine.poke();
    await w.clock.advance(POKE_MS);
  };

  await w.cmd(host, 'closed-lid:on');
  assert.equal(w.c3().closedLid.status, 'engaged');
  await w.cmd(host, 'closed-lid:off');
  assert.equal(w.mac.sleepDisabled, 0);
  assert.equal(w.mac.files.has(CLAIM), false);
  assert.equal(w.c3().closedLid.status, 'off');
  await render();
  assert.equal(w.c3().closedLid.status, 'off', 'the step after the disengage');

  await w.cmd(host, 'closed-lid:on');
  assert.equal(w.c3().closedLid.status, 'engaged');
  await w.cmd(host, 'mode:off');
  assert.equal(w.mac.sleepDisabled, 0);
  await render();
  // Mode Off runs no tick that would probe and correct it.
  await w.clock.advance(120000);
  await render();
  assert.deepEqual(w.c3().closedLid, { wanted: false, status: 'off', blocked: null });

  w.mac.sleepDisabled = 1;
  await w.cmd(host, 'refresh');
  await render();
  assert.equal(w.c3().closedLid.status, 'external');
  assert.equal(w.mac.files.has(CLAIM), false);
});

test('external: a foreign disablesleep 1 is reported with no claim and never written', async () => {
  const w = world();
  w.mac.sleepDisabled = 1;
  const host = await w.attach('host');
  assert.deepEqual(w.c3().closedLid, { wanted: false, status: 'external', blocked: null });

  await w.cmd(host, 'mode:on');
  await w.cmd(host, 'closed-lid:on');
  await w.clock.advance(120000);
  await w.cmd(host, 'closed-lid:off');
  await w.cmd(host, 'menu');
  assert.ok(!w.labels().some((l) => ['claim:write', 'pmset:0', 'pmset:1', 'sleepnow'].includes(l)));
  assert.equal(w.mac.files.has(CLAIM), false);
  assert.equal(w.mac.sleepDisabled, 1);
  assert.equal(w.c3().closedLid.status, 'external');
  assert.ok(w.toasts.some((n) => n.title === translate('en', 'toast.external')));
});

test('read-back failure → unavailable: the set is undone, the claim removed, no retry until a command', async () => {
  const w = world({ settings: { mode: 'on' } });
  w.mac.pmsetSticks = false;
  const host = await w.attach('host');
  const from = w.mark();
  await w.cmd(host, 'closed-lid:on');
  assert.deepEqual(w.labels(from).filter((l) => LID.has(l)), ['readback', 'claim:write', 'pmset:1', 'readback', 'pmset:0', 'claim:rm']);
  assert.equal(w.mac.files.has(CLAIM), false);
  assert.deepEqual(w.c3().closedLid, { wanted: true, status: 'unavailable', blocked: null });
  assert.ok(w.toasts.some((n) => n.level === 'error' && n.title === translate('en', 'error.lid.engage')));

  const after = w.mark();
  await w.clock.advance(120000);
  assert.ok(!w.labels(after).includes('pmset:1'));
  assert.equal(w.c3().closedLid.status, 'unavailable');
});

test('not installed → unavailable: no claim, no pmset', async () => {
  const w = world({ settings: { mode: 'on' } });
  w.mac.sudo = false;
  w.mac.aliveAge = null;
  const host = await w.attach('host');
  await w.cmd(host, 'closed-lid:on');
  assert.ok(!w.labels().some((l) => ['claim:write', 'pmset:0', 'pmset:1'].includes(l)));
  assert.equal(w.mac.sleepDisabled, 0);
  assert.deepEqual(w.c3().install, { sudo: false, failsafe: false });
  assert.equal(w.c3().closedLid.status, 'unavailable');

  // Installed later: the next command sees it.
  w.mac.sudo = true;
  w.mac.aliveAge = 3;
  await w.cmd(host, 'closed-lid:on');
  assert.equal(w.c3().closedLid.status, 'engaged');
  assert.equal(w.mac.sleepDisabled, 1);
});

test('fake facts override the probe only with debug: true', async () => {
  const w = world({ settings: { mode: 'on', closedLid: { enabled: true, acOnly: true }, fake: { ac: false } } });
  await w.attach('host');
  assert.equal(w.c3().closedLid.status, 'engaged', 'debug off: the real AC power counts');
  assert.equal(w.mac.sleepDisabled, 1);

  w.edit({ debug: true });
  await w.clock.advance(TICK_MS);
  assert.deepEqual(w.c3().closedLid, { wanted: true, status: 'blocked', blocked: 'ac' });
  assert.equal(w.mac.sleepDisabled, 0);
  assert.equal(w.mac.files.has(CLAIM), false);

  w.edit({ closedLid: { acOnly: false }, fake: { percent: 19 } });
  await w.clock.advance(TICK_MS);
  assert.equal(w.c3().closedLid.blocked, 'battery');
  w.edit({ fake: { percent: 24 } });
  await w.clock.advance(TICK_MS);
  assert.equal(w.c3().closedLid.blocked, 'battery');
  w.edit({ fake: { percent: 25 } });
  await w.clock.advance(TICK_MS);
  assert.equal(w.c3().closedLid.status, 'engaged');
  assert.equal(w.mac.sleepDisabled, 1);
});

test('a watchdog restore re-engages once with a toast; a second one turns closed-lid off', async () => {
  const w = world({ settings: { mode: 'on', closedLid: { enabled: true } } });
  await w.attach('host');
  await w.clock.advance(TICK_MS);

  w.mac.sleepDisabled = 0;
  w.mac.lastRestore = w.mac.nowSec;
  let from = w.mark();
  await w.clock.advance(TICK_MS);
  assert.ok(w.labels(from).includes('pmset:1'));
  assert.equal(w.mac.sleepDisabled, 1);
  assert.equal(w.c3().closedLid.status, 'engaged');
  assert.ok(w.toasts.some((n) => n.title === translate('en', 'toast.reengaged')));

  await w.clock.advance(TICK_MS * 2);
  w.mac.sleepDisabled = 0;
  w.mac.lastRestore = w.mac.nowSec;
  from = w.mark();
  await w.clock.advance(TICK_MS);
  assert.ok(!w.labels(from).includes('pmset:1'));
  assert.equal(w.settings().closedLid.enabled, false);
  assert.equal(w.mac.files.has(CLAIM), false);
  assert.ok(w.toasts.some((n) => n.title === translate('en', 'toast.override')));
});

test('SleepDisabled set to 0 outside Herdr with no restore record turns closed-lid off with a toast', async () => {
  const w = world({ settings: { mode: 'on', closedLid: { enabled: true } } });
  await w.attach('host');
  await w.clock.advance(TICK_MS);
  w.mac.sleepDisabled = 0;
  const from = w.mark();
  await w.clock.advance(TICK_MS);
  assert.ok(!w.labels(from).includes('pmset:1'));
  assert.equal(w.settings().closedLid.enabled, false);
  assert.equal(w.mac.files.has(CLAIM), false);
  assert.deepEqual(w.c3().closedLid, { wanted: false, status: 'off', blocked: null });
  assert.ok(w.toasts.some((n) => n.title === translate('en', 'toast.override')));
});

test('closed-lid stays held across a reload: the claim is adopted, not rewritten or released', async () => {
  const clock = new Clock(T0);
  const a = world({ clock, settings: { mode: 'on', closedLid: { enabled: true } } });
  const hostA = await a.attach('host');
  assert.equal(a.mac.sleepDisabled, 1);
  hostA.cx.close();
  await clock.advance(5000);

  const b = world({ clock, mac: a.mac });
  const from = b.mark();
  await b.attach('host');
  assert.ok(!b.labels(from).some((l) => ['claim:write', 'pmset:0', 'pmset:1', 'claim:rm'].includes(l)));
  assert.ok(b.labels(from).includes('claim:touch'));
  assert.equal(b.mac.sleepDisabled, 1);
  assert.equal(b.c3().closedLid.status, 'engaged');
});

test('a claim left by a Herdr that died is cleaned up; one held by another live Herdr blocks as other-instance', async () => {
  const dead = world({ settings: { mode: 'off' } });
  dead.mac.sleepDisabled = 1;
  dead.mac.files.set(CLAIM, { text: `${JSON.stringify({ v: 1, owner: { pid: 999, appHome: APP }, since: T0 - 60000 })}\n`, mtime: T0 - 20000 });
  await dead.attach('host');
  assert.deepEqual(dead.labels().filter((l) => LID.has(l)), ['pmset:0', 'readback', 'claim:rm']);
  assert.equal(dead.mac.sleepDisabled, 0);

  const other = world({ settings: { mode: 'on', closedLid: { enabled: true } } });
  other.mac.sleepDisabled = 1;
  other.mac.procs.set(777, HERDR_COMMAND);
  other.mac.files.set(CLAIM, { text: `${JSON.stringify({ v: 1, owner: { pid: 777, appHome: '/Users/me/other' }, since: T0 })}\n`, mtime: T0 });
  await other.attach('host');
  assert.ok(!other.labels().some((l) => ['claim:write', 'pmset:0', 'pmset:1', 'claim:rm'].includes(l)));
  assert.deepEqual(other.c3().closedLid, { wanted: true, status: 'blocked', blocked: 'other-instance' });
});
