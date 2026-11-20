// The keep-awake reducer (C10). Pure: every input arrives as an argument and events carry `now` (epoch ms).
//
// step(state, event, facts, settings) → {state, desired: {awake, display, closedLid, sleepNow}, effects}
//
// event: {type, now, command?, probed?}
//   "boot"    first step of an engine (state from initialState(runtime.json)); resumes the persisted mode.
//   "tick"    a step with freshly probed facts (timer tick, menu open, `refresh`).
//   "command" a C1 command: `command` is the nextCommand() text or a parseCommand() result.
//   "poke"    any other re-evaluation (render poke, agents changed) with the last facts.
//   Probe-counted safety rules (thermal clear, unreadable count) advance only on probed steps: "boot" and "tick",
//   or any event with `probed: true`.
// facts: the C5 probe facts (`ac`, `percent`, `sleepDisabled`, `lidClosed`, `lidCausesSleep`, `thermal`, booleans
//   and numbers or null) plus what the engine knows: `working` (agent count), `install` ({sudo, failsafe}),
//   `claimHeld` (we hold the claim), `otherInstance` (another Herdr holds one), `unavailable` (our last engage
//   failed its read-back).
// settings: C2 settings (normalized here again).
// effects: {type: "settings", settings} — write settings.json and pass these settings to later steps;
//          {type: "runtime", session, trigger} — the runtime.json session or trigger part changed;
//          {type: "log", message} — an unknown or malformed command was ignored (one console.log line).

import { MOD_ID, normalizeRuntime, normalizeSettings, parseCommand } from "./state.js";

const MINUTE_MS = 60000;
/** thermalState serious (2) or worse blocks closed-lid; two probes at 1 or below clear the block. */
const THERMAL_BLOCK = 2;
const THERMAL_CLEAR_PROBES = 2;
/** A battery block clears at floor + 5 % or on AC. */
const BATTERY_CLEAR_MARGIN = 5;
/** Consecutive unreadable probes that block closed-lid as `unknown`. */
const UNKNOWN_PROBES = 3;

/** The reducer state before the first step, from `runtime.json` (any parsed value, or null). */
export function initialState(runtime = null) {
  const r = normalizeRuntime(runtime);
  return {
    v: 1,
    // settings.mode as last applied; null until the first step resumes it.
    savedMode: null,
    session: r.session,
    // The mode `toggle` turns on, kept in runtime.json (a file from before it was kept: the session's mode, else On).
    lastMode: r.lastMode ?? (r.session && r.session.mode !== "timer" ? r.session.mode : "on"),
    trigger: r.trigger,
    agent: { lastWorkingAt: null },
    safety: { battery: false, thermal: false, thermalOk: 0, unreadable: 0 },
    awake: false,
    display: false,
    closedLid: { wanted: false, status: "off", blocked: null, engaged: false },
  };
}

const sameSession = (a, b) => (a === null || b === null ? a === b
  : a.mode === b.mode && a.origin === b.origin && a.startedAt === b.startedAt && a.endsAt === b.endsAt);

/** A command as text for parseCommand (it validates parsed objects again). */
function commandText(c) {
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof c.command === "string") return c.value == null ? c.command : `${c.command}:${c.value}`;
  return null;
}

export function step(prev, event, facts, rawSettings) {
  const now = event?.now;
  const f = facts ?? {};
  const settings = normalizeSettings(rawSettings);
  const before = prev ?? initialState(null);
  const s = {
    ...before,
    trigger: { ...before.trigger },
    agent: { ...before.agent },
    safety: { ...before.safety },
    closedLid: { ...before.closedLid },
  };
  const effects = [];
  let settingsChanged = false;

  const ac = typeof f.ac === "boolean" ? f.ac : null;
  const onAc = ac ?? s.trigger.lastAc;

  const writeMode = (mode) => {
    if (settings.mode !== mode) {
      settings.mode = mode;
      settingsChanged = true;
    }
  };
  // A user Off (command, toggle, timer cancel, settings edit) while on AC suppresses the AC trigger.
  const userOff = () => {
    s.session = null;
    if (onAc === true) s.trigger.suppressed = true;
    writeMode("off");
  };
  const startUser = (mode) => {
    if (!(s.session && s.session.origin === "user" && s.session.mode === mode)) {
      s.session = { mode, origin: "user", startedAt: now, endsAt: null };
    }
    s.lastMode = mode;
    writeMode(mode);
  };

  // 1. settings.mode: resume it on the first step, follow an edit made outside the engine afterwards.
  if (s.savedMode === null) {
    const kept = s.session;
    if (settings.mode === "on" || settings.mode === "agent") startUser(settings.mode);
    else if (settings.mode === "timer") {
      // A timer resumes only while its end is ahead (step 3 ends it otherwise).
      if (kept?.mode !== "timer") {
        s.session = null;
        writeMode("off");
      }
    } else s.session = kept?.origin === "trigger" && settings.trigger.ac.enabled ? kept : null;
  } else if (settings.mode !== s.savedMode) {
    if (settings.mode === "off") userOff();
    else if (settings.mode === "timer") {
      // No minutes to start a timer from: keep the current mode.
      if (s.session?.mode !== "timer") writeMode(s.session?.origin === "user" ? s.session.mode : "off");
    } else startUser(settings.mode);
  }

  // 2. Commands.
  if (event?.type === "command") {
    const cmd = parseCommand(commandText(event.command));
    if (!cmd) effects.push({ type: "log", message: `${MOD_ID}: ignored command ${JSON.stringify(event.command)}` });
    else if (cmd.command === "toggle") {
      if (s.session) userOff();
      else startUser(s.lastMode);
    } else if (cmd.command === "mode") {
      if (cmd.value === "off") userOff();
      else startUser(cmd.value);
    } else if (cmd.command === "timer") {
      if (cmd.value === "cancel") {
        if (s.session?.mode === "timer") userOff();
      } else {
        s.session = { mode: "timer", origin: "user", startedAt: now, endsAt: now + cmd.value * MINUTE_MS };
        writeMode("timer");
        if (!settings.timer.presetsMin.includes(cmd.value) && settings.timer.lastCustomMin !== cmd.value) {
          settings.timer.lastCustomMin = cmd.value;
          settingsChanged = true;
        }
      }
    } else if (cmd.command === "display") {
      const on = cmd.value === "toggle" ? !settings.display : cmd.value === "on";
      if (on !== settings.display) {
        settings.display = on;
        settingsChanged = true;
      }
    } else if (cmd.command === "closed-lid") {
      const on = cmd.value === "toggle" ? !settings.closedLid.enabled : cmd.value === "on";
      if (on !== settings.closedLid.enabled) {
        settings.closedLid.enabled = on;
        settingsChanged = true;
      }
    }
    // menu, refresh, install and uninstall belong to the engine and views.
  }

  // 3. A timer ends at endsAt (not a user Off: no suppression).
  if (s.session?.mode === "timer" && !(now < s.session.endsAt)) {
    s.session = null;
    writeMode("off");
  }

  // 4. AC trigger: unplugging ends only trigger sessions and clears the suppression; an unplugged → plugged edge
  //    with mode Off, the trigger on and no suppression starts a trigger session (settings.mode stays "off").
  if (ac === false) {
    if (s.session?.origin === "trigger") s.session = null;
    s.trigger.suppressed = false;
  } else if (ac === true && s.trigger.lastAc === false && settings.trigger.ac.enabled && !s.session && !s.trigger.suppressed) {
    s.session = { mode: settings.trigger.ac.mode, origin: "trigger", startedAt: now, endsAt: null };
  }
  if (ac !== null) s.trigger.lastAc = ac;

  // 5. Awake by the mode (the lid rule in 8 can still let the Mac sleep).
  const working = typeof f.working === "number" && f.working > 0;
  if (working) s.agent.lastWorkingAt = now;
  const session = s.session;
  let awake = false;
  if (session?.mode === "on") awake = true;
  else if (session?.mode === "agent") {
    const last = s.agent.lastWorkingAt;
    awake = working || (last !== null && now < last + settings.agent.lingerSec * 1000);
  } else if (session?.mode === "timer") awake = now < session.endsAt;

  // 6. Closed-lid safety state, advanced once per probe.
  const want = settings.closedLid.enabled && awake;
  const probed = typeof event?.probed === "boolean" ? event.probed : event?.type === "tick" || event?.type === "boot";
  if (probed) {
    const percent = typeof f.percent === "number" && Number.isFinite(f.percent) ? f.percent : null;
    const thermal = typeof f.thermal === "number" && Number.isFinite(f.thermal) ? f.thermal : null;
    // Thermal is read only while closed-lid is wanted (bin/probe.sh --thermal), so it counts only then.
    const unreadable = ac === null || (ac === false && percent === null) || (want && thermal === null);
    s.safety.unreadable = unreadable ? s.safety.unreadable + 1 : 0;
    if (thermal !== null && thermal >= THERMAL_BLOCK) {
      s.safety.thermal = true;
      s.safety.thermalOk = 0;
    } else if (thermal !== null && s.safety.thermal) {
      s.safety.thermalOk += 1;
      if (s.safety.thermalOk >= THERMAL_CLEAR_PROBES) {
        s.safety.thermal = false;
        s.safety.thermalOk = 0;
      }
    } else s.safety.thermalOk = 0;
    if (ac === true) s.safety.battery = false;
    else if (ac === false && percent !== null) {
      const floor = settings.closedLid.batteryFloor;
      if (percent < floor) s.safety.battery = true;
      else if (percent >= floor + BATTERY_CLEAR_MARGIN) s.safety.battery = false;
    }
  }

  // 7. Closed-lid: wanted while enabled and awake; the highest-priority block wins.
  const install = f.install ?? {};
  const available = install.sudo === true && install.failsafe === true && f.unavailable !== true;
  const external = (f.sleepDisabled === true || f.sleepDisabled === 1) && f.claimHeld !== true;
  let block = null;
  if (!available) block = "unavailable";
  else if (f.otherInstance === true) block = "other-instance";
  else if (external) block = "external";
  else if (s.safety.thermal) block = "thermal";
  else if (s.safety.battery) block = "battery";
  else if (settings.closedLid.acOnly && ac === false) block = "ac";
  else if (s.safety.unreadable >= UNKNOWN_PROBES) block = "unknown";
  const closedLid = want && block === null;
  let status = external ? "external" : "off";
  if (want) status = block === null ? "engaged" : block === "unavailable" || block === "external" ? block : "blocked";

  // 8. The lid (D7). Closed-lid ending with the lid shut puts the Mac to sleep. While the lid is shut and causes sleep
  //    and closed-lid is not engaged, nothing holds the Mac awake: a running holder's PreventSystemSleep would turn
  //    that sleep (lid or `pmset sleepnow`) into a dark wake on AC. Lid open, or CausesSleep No (clamshell with an
  //    external display): the mode decides again.
  const lidSleeps = f.lidClosed === true && f.lidCausesSleep === true;
  const engagedBefore = s.closedLid.engaged || f.claimHeld === true;
  const sleepNow = engagedBefore && !closedLid && lidSleeps;
  const held = awake && (closedLid || !lidSleeps);

  s.closedLid = { wanted: want, status, blocked: status === "blocked" ? block : null, engaged: closedLid };
  s.awake = held;
  s.display = held && settings.display;
  s.savedMode = settings.mode;

  if (settingsChanged) effects.push({ type: "settings", settings });
  if (!sameSession(before.session, s.session) || before.trigger.suppressed !== s.trigger.suppressed
    || before.trigger.lastAc !== s.trigger.lastAc) {
    effects.push({ type: "runtime", session: s.session, trigger: { ...s.trigger } });
  }
  return { state: s, desired: { awake: held, display: s.display, closedLid, sleepNow }, effects };
}
