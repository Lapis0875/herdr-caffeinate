// The keep-awake engine (C11): a module-scope singleton that probes, steps the reducer (core/machine.js),
// reconciles the caffeinate holder and closed-lid with what it asks for, and publishes C3.
//
// Lifetime (S2, S3). `owner: null` tasks stop when the copy that started them closes, so the engine records its
// starting copy; that copy's `detach()` marks it stopped and releases nothing (a quit is treated like a crash).
// The next host or chip copy's `attach()`/`ensure()` (init, render, and a 5 s check per copy) starts it again,
// resuming from runtime.json and settings.json. Menu copies never start it.
//
// All engine work runs in one loop task of the starting copy, and only that task ever resumes it: Herdr attributes a
// host call (exec, fs, a timer) to the copy whose call is running when it is made, and leaves a closed copy's calls
// pending for ever. A loop woken through a promise another copy resolved would run in that copy's call, so closing
// that copy (a menu) would strand the engine on a call that never settles. Other copies therefore only queue
// requests (commands, pokes, menu opens, settings changes); the loop picks them up on its own timer every POLL_MS.
// A run that still makes no progress for STALL_MS is replaced by a host or chip copy's check once two checks
// COPY_CHECK_MS apart both see it (a sleep of the Mac makes every timer late and is not a stuck run). A run that
// stopped can't touch anything: every host call goes through `io`, which throws STOPPED once its run is dead.
//
// Cycle (tick, poke, command): re-read settings.json when its text changed → probe (ticks, commands, menu,
// refresh) → step → reconcile holder → reconcile closed-lid → touch the claim (probed cycles) → runtime.json →
// publish C3 when it changed (always at boot).
// Ticks: 10 s while a claim is held or `debug` is on; 30 s while a session runs or the AC trigger is on; none
// otherwise. A light step (no probe) also runs exactly at a timer's end and at the agent linger's end.
//
// deps: exec, readTextFile, writeTextFile, mkdir(path) (recursive), terminals(), setShared(key, value),
// notify({title, level}), runCommand(name, args) (herdr `run`), checking(), appHome(), home(), now() (epoch ms),
// log(message), openMenu() (optional; `setMenuOpener` replaces it).

import { MOD_ID, SHARED_KEY, applyFake, buildShared, claimPath, normalizeSettings, parseCommand, sameShared, toRuntime } from "../core/state.js";
import { initialState, step } from "../core/machine.js";
import { resolveLanguage, setLanguage, t } from "../core/i18n.js";
import { parseProbe } from "../core/probe-parse.js";
import { workingAgents } from "./agents.js";
import { claimText, disengage, engage, parseClaim, sleepNow, touchClaim } from "./closed-lid.js";
import { commandOf, herdrProcess, holderArgv, holderKind, killVerified, launch, runs, secondsLeft, sweepOrphans, waitGone } from "./holder.js";
import { checkSudo, failsafeFresh } from "./privilege.js";
import { runProbe } from "./probe.js";
import { Store } from "./store.js";

/** Tick while a claim is held or `debug` is on. */
export const TICK_MS = 10000;
/** Tick while a session runs or the AC trigger is on. */
export const SESSION_TICK_MS = 30000;
/** `poke()` debounce. */
export const POKE_MS = 250;
/** Each host or chip copy checks this often that an engine runs (S2: a same-key replacement can close the
 *  starting copy after the new copy's init). */
export const COPY_CHECK_MS = 5000;
/** How long a command delivered to a later copy waits for the first-registered copy to deliver it too. */
export const COMMAND_WINDOW_MS = 300;
/** How often the loop picks up requests from other copies (it never lets them wake it). */
export const POLL_MS = 250;
/** A run with no loop step or host call settling for this long is stuck (every exec times out within 15 s): the
 *  next host or chip copy's check replaces it. */
export const STALL_MS = 60000;

const START_PENDING_MS = 2000;
const SUDO_RECHECK_MS = 5 * 60000;
const MENU_FRESH_MS = 1000;
const SLACK_MS = 50;
const ROLES = ["host", "chip", "menu"];

/** Runs `bin/install.sh` / `bin/uninstall.sh` in a tab that stays open until Enter, so the owner can read it. */
export const KEEP_OPEN = '/bin/sh "$1"; s=$?; printf "\\n[exit %s] Press Enter to close. " "$s"; read _';

const STOPPED = Symbol("herdr-caffeinate engine run stopped");
const errText = (e) => (e && typeof e === "object" && "message" in e ? e.message : String(e));
const clone = (v) => JSON.parse(JSON.stringify(v));
const noop = () => {};

/** One engine run, from a start to its stop. */
class Run {
  constructor(starter) {
    this.starter = starter;
    this.dead = false;
    this.booted = false;
    this.io = null;
    this.store = null;
    this.home = "";
    this.appHome = "";
    this.appPid = null;
    this.appCommand = null;
    this.locale = null;
    this.language = undefined;
    this.state = initialState(null);
    this.raw = parseProbe(null);
    this.probeAt = null;
    this.install = { sudo: false, failsafe: false };
    this.sudoAt = null;
    this.holder = null;
    this.holderEndsAt = null;
    this.holderFailed = false;
    // held: the claim is ours; applied: our `disablesleep 1` is in place; engagedAt: ms of the last engage;
    // reengaged: this episode already re-engaged once after a watchdog restore; fresh: written in this cycle;
    // notice: the toast to show once the next engage succeeds.
    this.claim = { held: false, applied: false, engagedAt: null, reengaged: false, fresh: false, notice: null };
    this.otherInstance = false;
    this.unavailable = false;
    this.working = 0;
    this.fullAt = -Infinity;
    this.lightAt = -Infinity;
    // Past this time (epoch ms) without progress the run counts as stuck.
    this.deadline = Infinity;
    // When a copy's check first found the run past its deadline (null: not overdue).
    this.overdueAt = null;
  }

  get settings() {
    return this.store.settings;
  }
}

export class Engine {
  constructor(deps) {
    this.deps = deps;
    this.copies = [];
    this.nextCopy = 1;
    this.run = null;
    this.starting = null;
    this.queue = [];
    this.inflight = null;
    this.pokeDue = null;
    this.recent = [];
    this.shared = null;
    this.menuOpener = typeof deps.openMenu === "function" ? deps.openMenu : null;
  }

  // ── Copies ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Registers a copy (`init`). role "host" (the hidden window), "chip" (a layout block) or "menu" (the popover).
   *  Host and chip copies start the engine unless `checking()`, and check every 5 s that it runs. Returns the
   *  copy's handle for the other calls. */
  attach(role, cx) {
    const copy = Object.freeze({ id: this.nextCopy++, role: ROLES.includes(role) ? role : "chip" });
    this.copies.push(copy);
    if (copy.role !== "menu" && cx && !this.deps.checking()) {
      this.ensure(copy, cx);
      cx.timer.every(COPY_CHECK_MS, (tcx) => this.ensure(copy, tcx));
    }
    return copy;
  }

  /** Unregisters a copy (`close()`). The starting copy's detach stops the engine; nothing is released. */
  detach(copy) {
    this.copies = this.copies.filter((c) => c !== copy);
    const run = this.run;
    if (run && run.starter === copy?.id) this.halt(run);
  }

  /** Starts the engine from a host or chip copy when none runs, or replaces a stuck run. Safe in `render`. */
  ensure(copy, cx) {
    if (this.deps.checking() || copy?.role === "menu" || !this.copies.includes(copy)) return;
    const now = this.deps.now();
    const run = this.run;
    if (run) {
      if (!(now > run.deadline)) {
        run.overdueAt = null;
        return;
      }
      // Stuck only when checks COPY_CHECK_MS apart both find it overdue: after the Mac sleeps, every timer is late
      // and the loop's own refreshes the deadline moments after the copy's check fires.
      if (run.overdueAt === null || now < run.overdueAt) run.overdueAt = now;
      if (now - run.overdueAt < COPY_CHECK_MS) return;
      this.log(`engine made no progress for ${Math.round((now - run.deadline + STALL_MS) / 1000)} s; restarting`);
      this.halt(run);
    }
    if (this.starting !== null && now - this.starting < START_PENDING_MS) return;
    this.starting = now;
    cx.timer.after(0, (tcx) => this.start(copy, tcx), { owner: null });
  }

  /** Whether no host copy is registered (chip and menu copies open the host then, C9/C11). */
  needsHost() {
    return !this.copies.some((c) => c.role === "host");
  }

  /** True while an engine run is booted and not stopped. */
  running() {
    return this.run !== null && this.run.booted && !this.run.dead;
  }

  /** Replaces how the `menu` command opens the popover. */
  setMenuOpener(fn) {
    this.menuOpener = typeof fn === "function" ? fn : null;
  }

  // ── Requests ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Re-evaluates soon (every copy's `render()`), debounced 250 ms; no probe. */
  poke() {
    if (this.pokeDue !== null) return;
    this.pokeDue = this.deps.now() + POKE_MS;
  }

  /**
   * A `nextCommand()` text delivered to `copy`. Every shown copy receives each command; only the first-registered
   * copy handles it. A command only later copies received (the first one is not shown) is handled once after
   * COMMAND_WINDOW_MS. Resolves with the parsed command once handled by this delivery, else null.
   */
  command(copy, text) {
    if (typeof text !== "string") return Promise.resolve(null);
    const now = this.deps.now();
    this.recent = this.recent.filter((e) => e.pending || now - e.at <= COMMAND_WINDOW_MS);
    const id = copy?.id;
    if (id !== undefined && id === this.copies[0]?.id) {
      const waiting = this.recent.find((e) => e.pending && e.text === text);
      if (waiting) {
        waiting.pending = false;
        waiting.seen.add(id);
      } else this.recent.push({ text, at: now, pending: false, seen: new Set([id]) });
      return this.request({ kind: "command", text });
    }
    const match = this.recent.find((e) => e.text === text && !e.seen.has(id) && now - e.at <= COMMAND_WINDOW_MS);
    if (match) match.seen.add(id);
    else this.recent.push({ text, at: now, pending: true, seen: new Set([id]) });
    return Promise.resolve(null);
  }

  /** Runs a C1 command from this mod's own UI (a menu click): no copy routing. Resolves with the parsed command
   *  (null when unknown) once handled. */
  perform(text) {
    return this.request({ kind: "command", text: String(text) });
  }

  /** The menu opened (its view's `init`): a probe and a step at once. */
  menu() {
    return this.request({ kind: "menu" });
  }

  /** Changes settings.json from the menu: `mutator(settings)` edits a copy; the result is normalized, written and
   *  stepped at once. */
  update(mutator) {
    return this.request({ kind: "update", mutator });
  }

  /** What the views draw: `{running, shared (the last C3 object or null), settings, settingsOk, facts (probe facts
   *  with debug fakes), install, trigger}`. `trigger` is the reducer's AC-trigger state `{suppressed, lastAc}`
   *  (`suppressed`: a user Off on AC holds the trigger until the next unplug; `lastAc`: the last AC reading, null
   *  before one). `settings`, `facts`, `install` and `trigger` are null while stopped. Read-only; change settings through
   *  commands or `update()`. */
  snapshot() {
    const run = this.run;
    const live = run !== null && run.booted && !run.dead;
    return {
      running: live,
      shared: this.shared,
      settings: live ? run.settings : null,
      settingsOk: live ? run.store.settingsOk : true,
      facts: live ? applyFake(run.raw, run.settings) : null,
      install: live ? { ...run.install } : null,
      trigger: live ? { suppressed: run.state.trigger.suppressed === true, lastAc: run.state.trigger.lastAc ?? null } : null,
    };
  }

  request(req) {
    return new Promise((resolve) => this.queue.push({ ...req, resolve }));
  }

  // ── Run lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────

  start(copy, cx) {
    this.starting = null;
    if (this.run || this.deps.checking() || !this.copies.includes(copy)) return;
    const run = new Run(copy.id);
    run.deadline = this.deps.now() + STALL_MS;
    this.run = run;
    cx.spawn((lcx) => this.loop(run, lcx), { owner: null });
  }

  /** Marks a run stopped. A request it was handling goes back to the queue for the next run, unless it is a command
   *  that already counts as applied (see `advance`): it is finished here, and the next run's boot carries out the rest
   *  from settings.json and runtime.json. */
  halt(run) {
    if (run.dead) return;
    run.dead = true;
    if (this.run === run) this.run = null;
    const req = this.inflight;
    this.inflight = null;
    if (!req) return;
    if (req.applied) req.resolve(req.kind === "command" ? parseCommand(req.text) : null);
    else this.queue.unshift(req);
  }

  /** Host calls that throw STOPPED once the run is dead (before the call and after it settles); each settled call
   *  counts as progress. */
  bind(run) {
    const guard = (fn) => async (...args) => {
      if (run.dead) throw STOPPED;
      run.deadline = Math.max(run.deadline, this.deps.now() + STALL_MS);
      try {
        return await fn(...args);
      } finally {
        if (run.dead) throw STOPPED;
        run.deadline = this.deps.now() + STALL_MS;
      }
    };
    const d = this.deps;
    return {
      exec: guard(d.exec),
      readTextFile: guard(d.readTextFile),
      writeTextFile: guard(d.writeTextFile),
      mkdir: guard(d.mkdir),
    };
  }

  async loop(run, cx) {
    try {
      await this.boot(run);
      for (;;) {
        const delay = this.delay(run);
        run.deadline = this.deps.now() + delay + STALL_MS;
        if (delay > 0) await cx.sleep(delay);
        if (run.dead) return;
        await this.service(run);
      }
    } catch (e) {
      // STOPPED, or the copy's cx refused (it closed or its build reloaded) without a detach.
      if (e !== STOPPED && !run.dead) this.log(`engine stopped: ${errText(e)}`);
      this.halt(run);
    }
  }

  async boot(run) {
    run.io = this.bind(run);
    run.home = this.deps.home();
    run.appHome = this.deps.appHome();
    run.store = new Store(run.io, run.appHome, (e) => e === STOPPED);
    const io = run.io;
    await run.store.ensureDir();
    const me = await herdrProcess(io.exec);
    run.appPid = me?.pid ?? null;
    run.appCommand = me?.command || null;
    if (!me) this.log("the Herdr pid could not be read; no holder can start");
    await run.store.loadSettings(true);
    const runtime = await run.store.loadRuntime();
    await run.store.loadState();
    run.state = initialState(runtime);
    run.locale = await this.readLocale(run);
    // Adopt the holder this Herdr started before a reload, after checking its argv.
    const h = runtime.holder;
    const kind = h ? holderKind(h.argv) : null;
    if (h && kind && run.appPid !== null && h.appPid === run.appPid && kind.appPid === run.appPid
      && (await runs(io.exec, h.pid, h.argv))) {
      run.holder = h;
      run.holderEndsAt = kind.timed ? run.state.session?.endsAt ?? null : null;
    }
    // Every other holder of this Herdr is an orphan of a reload that lost its launch result.
    if (run.appPid !== null) await sweepOrphans(io.exec, run.appPid, run.holder?.pid ?? null);
    run.booted = true;
    await this.cycle(run, { event: { type: "boot" }, probe: true, privilege: true, publish: true });
  }

  async readLocale(run) {
    try {
      const r = await run.io.exec("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], { timeout: 5000 });
      return r?.code === 0 ? r.stdout : null;
    } catch (e) {
      if (e === STOPPED) throw e;
      return null;
    }
  }

  /** Full-tick interval: 10 s with a claim or `debug`, or while a session waits with the lid shut and causing sleep
   *  (D7: no holder then, and the next probe after the lid opens starts it again); 30 s with a session or the AC
   *  trigger, else none. A tick missed while the Mac slept is overdue, so it runs as soon as the Mac wakes. */
  fullInterval(run) {
    if (!run.booted) return null;
    const lid = applyFake(run.raw, run.settings);
    const lidSleeps = run.state.session !== null && lid.lidClosed === true && lid.lidCausesSleep === true;
    if (run.settings.debug === true || run.claim.held || lidSleeps) return TICK_MS;
    if (run.state.session !== null || run.settings.trigger.ac.enabled) return SESSION_TICK_MS;
    return null;
  }

  /** When a light step is due while a session runs: at the timer end, and at the agent linger end once no agent
   *  works (while one works the Mac is held anyway, and every step would move the end again). A due counts as done
   *  by a step at or after it (`run.lightAt` is the time the last step ran with). */
  timeDues(run) {
    const session = run.state.session;
    if (!run.booted || !session) return [];
    const dues = [];
    if (session.mode === "timer") dues.push(session.endsAt);
    const last = run.state.agent?.lastWorkingAt ?? null;
    if (session.mode === "agent" && last !== null && run.working === 0) dues.push(last + run.settings.agent.lingerSec * 1000);
    return dues.filter((due) => due > run.lightAt);
  }

  delay(run) {
    if (this.queue.length > 0) return 0;
    const now = this.deps.now();
    const dues = [now + POLL_MS];
    if (this.pokeDue !== null) dues.push(this.pokeDue);
    for (const e of this.recent) if (e.pending) dues.push(e.at + COMMAND_WINDOW_MS);
    const full = this.fullInterval(run);
    if (full !== null) dues.push(run.fullAt + full);
    dues.push(...this.timeDues(run));
    return Math.max(0, Math.min(...dues) - now);
  }

  async service(run) {
    const now = this.deps.now();
    for (const e of this.recent) {
      if (e.pending && now >= e.at + COMMAND_WINDOW_MS - SLACK_MS) {
        e.pending = false;
        this.queue.push({ kind: "command", text: e.text, resolve: noop });
      }
    }
    this.recent = this.recent.filter((e) => e.pending || now - e.at <= COMMAND_WINDOW_MS);
    while (this.queue.length > 0) {
      const req = this.queue.shift();
      this.inflight = req;
      let value = null;
      try {
        value = await this.handle(run, req);
      } catch (e) {
        if (e === STOPPED || run.dead) throw STOPPED;
        this.log(`${req.kind} failed: ${errText(e)}`);
      }
      if (run.dead) throw STOPPED;
      this.inflight = null;
      req.resolve(value);
    }
    const at = this.deps.now();
    const full = this.fullInterval(run);
    try {
      if (full !== null && at >= run.fullAt + full - SLACK_MS) {
        await this.cycle(run, { event: { type: "tick" }, probe: true });
      } else if ((this.pokeDue !== null && at >= this.pokeDue - SLACK_MS) || this.timeDues(run).some((d) => at >= d - SLACK_MS)) {
        await this.cycle(run, { event: { type: "poke" } });
      }
    } catch (e) {
      if (e === STOPPED || run.dead) throw STOPPED;
      this.log(`tick failed: ${errText(e)}`);
    }
  }

  async handle(run, req) {
    if (req.kind === "menu") {
      if (run.probeAt !== null && this.deps.now() - run.probeAt < MENU_FRESH_MS) return null;
      await this.cycle(run, { event: { type: "tick" }, probe: true, privilege: true });
      return null;
    }
    if (req.kind === "update") {
      await this.writeSettings(run, req.mutator);
      await this.cycle(run, { event: { type: "poke" } });
      return null;
    }
    const cmd = parseCommand(req.text);
    if (cmd === null) {
      // The reducer logs it once.
      await this.cycle(run, { event: { type: "command", command: req.text } });
      return null;
    }
    if (cmd.command === "install" || cmd.command === "uninstall") {
      this.openScript(run, cmd.command);
      return cmd;
    }
    // Any command may retry a closed-lid engage whose read-back failed.
    run.unavailable = false;
    // Doing a toggle twice undoes it (see `advance` and `halt`).
    req.once = cmd.command === "toggle" || cmd.value === "toggle";
    const lid = cmd.command === "closed-lid";
    await this.cycle(run, {
      event: { type: "command", command: req.text, probed: true },
      probe: true,
      privilege: true,
      thermal: lid,
      forceSettings: cmd.command === "refresh",
    });
    if (lid && run.settings.closedLid.enabled && run.state.closedLid.status === "external") this.say(run, "toast.external");
    if (cmd.command === "menu") this.openMenu(run);
    return cmd;
  }

  // ── The cycle ──────────────────────────────────────────────────────────────────────────────────────────────────

  async cycle(run, { event, probe = false, privilege = false, thermal = false, forceSettings = false, publish = false }) {
    const now = this.deps.now();
    if (probe) run.fullAt = now;
    if (this.pokeDue !== null && this.pokeDue <= now + SLACK_MS) this.pokeDue = null;
    const loaded = await run.store.loadSettings(forceSettings);
    if (loaded.changed && !loaded.ok) this.log("settings.json is not a JSON object; the last good settings stay in use");
    this.applyLanguage(run);
    if (probe) await this.observe(run, { privilege, thermal });
    let out = await this.advance(run, event);
    // The holder first: when closed-lid ends with the lid shut, it is stopped (and gone) before `pmset sleepnow`.
    await this.reconcileHolder(run, out.desired, probe);
    if (await this.reconcileLid(run, out.desired)) {
      // Closed-lid changed the facts (an engage that failed, a disengage): step again so C3 shows the read-back, and
      // follow what is held now (e.g. the lid shut without closed-lid holds nothing, D7).
      out = await this.advance(run, { type: "poke" });
      await this.reconcileHolder(run, out.desired, false);
    }
    if (probe && run.claim.held && run.claim.applied && !run.claim.fresh) await touchClaim(run.io.exec, run.home);
    run.claim.fresh = false;
    await run.store.saveRuntime(toRuntime(run.state, run.holder, null));
    await this.publish(run, publish);
    this.applyLanguage(run);
    return out;
  }

  /** Probe facts, privilege, the claim's owner and an outside restore. */
  async observe(run, { privilege, thermal }) {
    const io = run.io;
    if (run.appPid === null) {
      const me = await herdrProcess(io.exec);
      run.appPid = me?.pid ?? null;
      run.appCommand = me?.command || null;
    }
    run.probeAt = this.deps.now();
    run.raw = await runProbe(io.exec, run.appHome, { thermal: thermal || run.settings.closedLid.enabled });
    const failsafe = failsafeFresh(run.raw.failsafeAliveAge);
    const periodic = run.settings.closedLid.enabled && run.sudoAt !== null && run.probeAt - run.sudoAt >= SUDO_RECHECK_MS;
    let sudo = run.install.sudo;
    if (privilege || periodic || run.sudoAt === null || failsafe !== run.install.failsafe) {
      sudo = await checkSudo(io.exec);
      run.sudoAt = run.probeAt;
    }
    // An install or uninstall since the last look: a failed engage may be retried.
    if (sudo !== run.install.sudo || failsafe !== run.install.failsafe) run.unavailable = false;
    run.install = { sudo, failsafe };
    await this.classifyClaim(run);
    await this.checkRestore(run);
  }

  /** Whose the claim is when we don't hold it: another live Herdr's (`otherInstance`), else ours to keep or end
   *  (left by this Herdr before a reload, or by a Herdr that died). */
  async classifyClaim(run) {
    const c = run.claim;
    const exists = run.raw.claimAge !== null;
    if (c.held) {
      run.otherInstance = false;
      // Our claim was removed under us: an engage writes it again, a disengage has nothing to remove.
      if (!exists) c.applied = false;
      return;
    }
    run.otherInstance = false;
    if (!exists || run.appPid === null) return;
    let text = null;
    try {
      text = await run.io.readTextFile(claimPath(run.home));
    } catch (e) {
      if (e === STOPPED) throw e;
    }
    const owner = parseClaim(text);
    if (owner && owner.pid !== run.appPid) {
      const command = await commandOf(run.io.exec, owner.pid);
      if (command !== null && (run.appCommand === null || command === run.appCommand)) {
        run.otherInstance = true;
        return;
      }
    }
    c.held = true;
    c.applied = run.raw.sleepDisabled === true;
    c.engagedAt = owner?.since ?? run.probeAt - Math.max(0, run.raw.claimAge) * 1000;
    c.reengaged = false;
    c.notice = null;
  }

  /** SleepDisabled went back to 0 under our claim: the watchdog's `last-restore` is newer than our engage → engage
   *  again once with a toast; otherwise (or a second time) closed-lid was turned off outside Herdr → turn the setting
   *  off with a toast (C11). */
  async checkRestore(run) {
    const c = run.claim;
    if (!(c.held && c.applied) || run.raw.sleepDisabled !== false) return;
    if (c.engagedAt !== null && run.probeAt <= c.engagedAt) return;
    c.applied = false;
    const restore = run.raw.lastRestore;
    const byWatchdog = restore !== null && c.engagedAt !== null && restore >= Math.floor(c.engagedAt / 1000);
    if (byWatchdog && !c.reengaged) {
      c.reengaged = true;
      c.notice = "toast.reengaged";
      return;
    }
    await this.writeSettings(run, (s) => {
      s.closedLid.enabled = false;
    });
    this.say(run, "toast.override");
  }

  /** The reducer's facts: the probe (debug fakes applied), agents, privilege and the claim. */
  facts(run) {
    let working = 0;
    try {
      working = workingAgents(this.deps.terminals(), run.settings.agent.includeRemote);
    } catch {
      working = 0;
    }
    // The first step after the last agent stopped still counts it, so the linger starts when the engine saw it stop
    // rather than at the step before. With no linger it ends at once.
    const carry = working === 0 && run.working > 0 && run.settings.agent.lingerSec > 0;
    const counted = carry ? run.working : working;
    run.working = working;
    return {
      ...applyFake(run.raw, run.settings),
      working: counted,
      install: { ...run.install },
      claimHeld: run.claim.held,
      otherInstance: run.otherInstance,
      unavailable: run.unavailable,
    };
  }

  /** One reducer step; a settings effect is written, and on a stale settings.json the step runs again on the
   *  re-read settings. A session or trigger change is then written to runtime.json at once, so a command's whole
   *  outcome is on disk before the slow reconcile. When a command counts as applied (`halt` then finishes it instead of
   *  doing it again in the next run): a toggle from its first write on, since doing it again would undo it; any other
   *  command only once all of its writes settled, since doing it again changes nothing, and a `timer:<n>` halted
   *  before its session reached runtime.json would otherwise end up Off. */
  async advance(run, event) {
    const facts = this.facts(run);
    const req = event.type === "command" ? this.inflight : null;
    const applied = () => {
      if (req && !run.dead) req.applied = true;
    };
    for (let attempt = 0; ; attempt += 1) {
      const now = this.deps.now();
      const out = step(run.state, { ...event, now }, facts, run.settings);
      // Nothing is awaited between this and the first write's call, so the write is under way once it is marked.
      if (req?.once) applied();
      const effect = out.effects.find((e) => e.type === "settings");
      if (effect && !(await run.store.saveSettings(effect.settings))) {
        if (attempt === 0 && run.store.settingsOk) {
          await run.store.loadSettings(true);
          continue;
        }
        run.store.settings = effect.settings;
        this.log("settings.json was not written; the change holds until Herdr restarts");
      }
      for (const e of out.effects) if (e.type === "log") this.log(e.message, false);
      run.state = out.state;
      // Dues are measured against the time the step ran with, not the cycle's start: a step stamps the agent's last
      // working time with its own `now`, which is later than the cycle's start after the awaited reads.
      run.lightAt = now;
      if (out.effects.some((e) => e.type === "runtime")) await run.store.saveRuntime(toRuntime(run.state, run.holder, null));
      applied();
      return out;
    }
  }

  /** Applies `mutator` to the current settings and writes them (once more after a stale read). */
  async writeSettings(run, mutator) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await run.store.loadSettings(true);
      const draft = clone(run.settings);
      try {
        mutator(draft);
      } catch (e) {
        this.log(`settings change failed: ${errText(e)}`);
        return;
      }
      const next = normalizeSettings(draft);
      if (await run.store.saveSettings(next)) return;
      if (attempt === 1 || !run.store.settingsOk) {
        run.store.settings = next;
        this.say(run, "error.settings.save", { detail: run.store.settingsOk ? "settings.json changed while saving" : "settings.json is not valid JSON" }, "error");
        return;
      }
    }
  }

  /** The holder follows `desired.awake` and `desired.display`; timer sessions carry `-t <seconds left>`. A new
   *  holder starts before the old one ends; a process is killed only after its pid and argv match. With
   *  `desired.sleepNow` the killed holder is waited for, so its PreventSystemSleep is gone before `pmset sleepnow`
   *  (D7; the assertion would turn that sleep into a dark wake on AC). */
  async reconcileHolder(run, desired, probed) {
    const io = run.io;
    const old = run.holder;
    if (!desired.awake) {
      if (old && (await killVerified(io.exec, old.pid, old.argv)) === "killed" && desired.sleepNow) {
        if (!(await waitGone(io.exec, old.pid))) this.log(`holder ${old.pid} still runs 1 s after TERM; sleeping anyway`);
      }
      run.holder = null;
      run.holderEndsAt = null;
      run.holderFailed = false;
      return;
    }
    if (run.appPid === null) return;
    const session = run.state.session;
    const endsAt = session?.mode === "timer" ? session.endsAt : null;
    const kind = old ? holderKind(old.argv) : null;
    const fits = kind !== null && old.appPid === run.appPid && kind.appPid === run.appPid && kind.display === desired.display
      && kind.timed === (endsAt !== null) && (endsAt === null || run.holderEndsAt === endsAt);
    if (fits) {
      if (!probed || (await runs(io.exec, old.pid, old.argv))) return;
      // It ended outside Herdr: start another.
      run.holder = null;
    } else if (!probed && run.holderFailed) return;
    const argv = holderArgv(run.appPid, { display: desired.display, seconds: endsAt === null ? null : secondsLeft(endsAt, this.deps.now()) });
    const pid = await launch(io.exec, argv);
    if (pid === null) {
      if (!run.holderFailed) this.say(run, "error.holder", { detail: "/bin/sh gave no pid" }, "error");
      run.holderFailed = true;
      return;
    }
    run.holderFailed = false;
    run.holder = { pid, argv, appPid: run.appPid };
    run.holderEndsAt = endsAt;
    if (!fits && old) await killVerified(io.exec, old.pid, old.argv);
  }

  /** Closed-lid follows `desired.closedLid` (C11 engage and disengage); `sleepNow` runs `pmset sleepnow` (D7). Every
   *  read-back becomes the `SleepDisabled` fact until the next probe. Returns true when the outcome changed the facts
   *  (external, unavailable, a disengage), so the step runs again before C3 is published. */
  async reconcileLid(run, desired) {
    const io = run.io;
    const c = run.claim;
    let restep = false;
    let slept = false;
    if (desired.closedLid && !(c.held && c.applied)) {
      const now = this.deps.now();
      const result = await engage(io.exec, { home: run.home, text: claimText(run.appPid, run.appHome, now), held: c.held });
      if (result === "engaged") {
        if (!c.held) c.reengaged = false;
        Object.assign(c, { held: true, applied: true, engagedAt: now, fresh: true });
        run.raw = { ...run.raw, sleepDisabled: true };
        run.unavailable = false;
        if (c.notice) this.say(run, c.notice);
        c.notice = null;
      } else {
        if (result === "external") run.raw = { ...run.raw, sleepDisabled: true };
        else {
          run.unavailable = true;
          this.say(run, "error.lid.engage", {}, "error");
        }
        Object.assign(c, { held: false, applied: false, notice: null });
        restep = true;
      }
    } else if (!desired.closedLid && c.held) {
      // Without this the probe from before the disengage (SleepDisabled 1) and the removed claim read as `external`
      // until the next probe, which never comes with mode Off (F4).
      const after = await disengage(io.exec, { home: run.home, sleep: desired.sleepNow });
      slept = desired.sleepNow;
      Object.assign(c, { held: false, applied: false, reengaged: false, notice: null });
      run.raw = { ...run.raw, sleepDisabled: after };
      if (after !== false) this.say(run, "error.lid.restore", {}, "error");
      restep = true;
    }
    if (desired.sleepNow && !slept) await sleepNow(io.exec);
    // The reducer's `engaged` follows what is in place, so a failed engage is no engaged → not-engaged transition.
    run.state = { ...run.state, closedLid: { ...run.state.closedLid, engaged: c.held && c.applied } };
    return restep;
  }

  /** Publishes C3 (shared key and state.json) when it changed, or always (`force`, at boot). */
  async publish(run, force) {
    const shared = buildShared(run.state, run.install, this.deps.now());
    if (!force && sameShared(this.shared, shared)) return;
    if (run.dead) throw STOPPED;
    this.shared = shared;
    try {
      this.deps.setShared(SHARED_KEY, shared);
    } catch (e) {
      this.log(`setShared failed: ${errText(e)}`);
    }
    await run.store.saveState(shared);
  }

  applyLanguage(run) {
    const setting = run.settings.language;
    if (run.dead || setting === run.language) return;
    run.language = setting;
    setLanguage(resolveLanguage(setting, run.locale));
  }

  openScript(run, name) {
    if (run.dead) return;
    const script = `${run.appHome.replace(/\/+$/, "")}/mods/${MOD_ID}/bin/${name}.sh`;
    try {
      this.deps.runCommand("tab.new", { name: `${MOD_ID} ${name}`, argv: ["/bin/sh", "-c", KEEP_OPEN, "sh", script] });
    } catch (e) {
      this.log(`tab.new for ${name}.sh failed: ${errText(e)}`);
      this.say(run, "error.tab", { script: `${name}.sh` }, "error");
    }
  }

  openMenu(run) {
    if (run.dead || !this.menuOpener) return;
    try {
      this.menuOpener();
    } catch (e) {
      this.log(`menu did not open: ${errText(e)}`);
    }
  }

  say(run, key, vars = {}, level = "info") {
    if (run.dead) return;
    try {
      this.deps.notify({ title: t(key, vars), level });
    } catch (e) {
      this.log(`notify failed: ${errText(e)}`);
    }
  }

  log(message, prefix = true) {
    try {
      this.deps.log(prefix ? `[${MOD_ID}] ${message}` : message);
    } catch {
      // Logging must never stop the engine.
    }
  }
}

/** The engine for a set of host bindings (sys/index.js binds Herdr's). */
export const createEngine = (deps) => new Engine(deps);
