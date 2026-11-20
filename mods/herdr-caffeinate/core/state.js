// Names, settings (C2), runtime state (C2), commands (C1) and the shared state shape (C3). Pure: no clock, no I/O;
// callers pass `now` and paths.

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const intIn = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Names ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MOD_ID = "herdr-caffeinate";
/** The only key other mods read (C3). */
export const SHARED_KEY = "herdr-caffeinate.state";
export const SHARED_VERSION = 1;

export const MODES = Object.freeze(["off", "on", "agent", "timer"]);
export const LANGUAGES = Object.freeze(["system", "ko", "en"]);
/** Modes a session runs in (Off is no session); an AC-trigger session uses one of TRIGGER_MODES. */
export const SESSION_MODES = Object.freeze(["on", "agent", "timer"]);
export const TRIGGER_MODES = Object.freeze(["on", "agent"]);
export const ORIGINS = Object.freeze(["user", "trigger"]);
export const REASONS = Object.freeze(["user", "agent", "timer", "trigger"]);
export const CLOSED_LID_STATUSES = Object.freeze(["off", "engaged", "blocked", "unavailable", "external"]);
export const BLOCK_REASONS = Object.freeze(["ac", "battery", "thermal", "unknown", "other-instance"]);

export const TIMER_MIN = 1;
export const TIMER_MAX = 1440;
export const BATTERY_FLOOR_MIN = 10;
export const BATTERY_FLOOR_MAX = 90;
/** `install.failsafe` holds while the watchdog's `alive` file is at most this old (C6). */
export const FAILSAFE_FRESH_SEC = 60;

export const DAEMON_LABEL = "io.github.lapis0875.herdr-caffeinate.failsafe";
export const SUDOERS_PATH = "/etc/sudoers.d/herdr-caffeinate";
export const HELPER_PATH = `/Library/PrivilegedHelperTools/${DAEMON_LABEL}`;
export const PLIST_PATH = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;
export const WATCHDOG_DIR = "/var/db/herdr-caffeinate";

const trimSlash = (p) => String(p).replace(/\/+$/, "");

/** `<app home>/data/herdr-caffeinate` and the three files in it (C2, C3). */
export const dataDir = (appHome) => `${trimSlash(appHome)}/data/${MOD_ID}`;
export const settingsPath = (appHome) => `${dataDir(appHome)}/settings.json`;
export const runtimePath = (appHome) => `${dataDir(appHome)}/runtime.json`;
export const statePath = (appHome) => `${dataDir(appHome)}/state.json`;

/** `~/.herdr/herdr-caffeinate` and the claim and engine heartbeat files in it (C4). */
export const runtimeDir = (home) => `${trimSlash(home)}/.herdr/${MOD_ID}`;
export const claimPath = (home) => `${runtimeDir(home)}/claim`;
export const enginePath = (home) => `${runtimeDir(home)}/engine`;

// ── Settings (C2) ────────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_PRESETS = Object.freeze([15, 60, 120]);
const MAX_PRESETS = 8;

/** A fresh copy of the default settings. */
export function defaultSettings() {
  return {
    version: 1,
    language: "system",
    mode: "off",
    display: false,
    timer: { presetsMin: [...DEFAULT_PRESETS], lastCustomMin: 45 },
    agent: { lingerSec: 30, includeRemote: false },
    closedLid: { enabled: false, acOnly: true, batteryFloor: 20 },
    trigger: { ac: { enabled: false, mode: "on" } },
    debug: false,
  };
}

/** Copies every key of `source` that `target` does not have and that is not one of `known` (unknown fields are
 *  kept; a known field that normalized to absent stays absent). */
function keepUnknown(target, source, known = []) {
  if (isObject(source)) {
    for (const key of Object.keys(source)) if (!(key in target) && !known.includes(key)) target[key] = source[key];
  }
  return target;
}

function presets(v) {
  const ok = Array.isArray(v) && v.length >= 1 && v.length <= MAX_PRESETS
    && v.every((n) => Number.isInteger(n) && n >= TIMER_MIN && n <= TIMER_MAX);
  return ok ? [...v] : [...DEFAULT_PRESETS];
}

/** `batteryFloor` clamps to 10..90 (rounded); a non-number falls back to the default. */
function batteryFloor(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), BATTERY_FLOOR_MIN, BATTERY_FLOOR_MAX) : fallback;
}

/** Debug-only fact overrides; invalid entries are dropped, unknown entries kept. Null when absent or not an object. */
function fake(v) {
  if (!isObject(v)) return null;
  const out = { ...v };
  if ("ac" in out && typeof out.ac !== "boolean") delete out.ac;
  if ("lidClosed" in out && typeof out.lidClosed !== "boolean") delete out.lidClosed;
  if ("percent" in out && !Number.isInteger(out.percent)) delete out.percent;
  if ("percent" in out) out.percent = clamp(out.percent, 0, 100);
  if ("thermal" in out && !(Number.isInteger(out.thermal) && out.thermal >= 0 && out.thermal <= 3)) delete out.thermal;
  return out;
}

/** The C2 settings from any parsed value: every known field validated (an invalid one falls back to its default,
 *  `batteryFloor` clamps to 10..90), unknown fields kept at every level. Never throws; always a new object. */
export function normalizeSettings(raw) {
  const d = defaultSettings();
  const r = isObject(raw) ? raw : {};
  const timer = isObject(r.timer) ? r.timer : {};
  const agent = isObject(r.agent) ? r.agent : {};
  const closedLid = isObject(r.closedLid) ? r.closedLid : {};
  const trigger = isObject(r.trigger) ? r.trigger : {};
  const ac = isObject(trigger.ac) ? trigger.ac : {};
  const out = {
    version: d.version,
    language: oneOf(r.language, LANGUAGES, d.language),
    mode: oneOf(r.mode, MODES, d.mode),
    display: bool(r.display, d.display),
    timer: keepUnknown({
      presetsMin: presets(timer.presetsMin),
      lastCustomMin: intIn(timer.lastCustomMin, TIMER_MIN, TIMER_MAX, d.timer.lastCustomMin),
    }, timer),
    agent: keepUnknown({
      lingerSec: intIn(agent.lingerSec, 0, 3600, d.agent.lingerSec),
      includeRemote: bool(agent.includeRemote, d.agent.includeRemote),
    }, agent),
    closedLid: keepUnknown({
      enabled: bool(closedLid.enabled, d.closedLid.enabled),
      acOnly: bool(closedLid.acOnly, d.closedLid.acOnly),
      batteryFloor: batteryFloor(closedLid.batteryFloor, d.closedLid.batteryFloor),
    }, closedLid),
    trigger: keepUnknown({
      ac: keepUnknown({
        enabled: bool(ac.enabled, d.trigger.ac.enabled),
        mode: oneOf(ac.mode, TRIGGER_MODES, d.trigger.ac.mode),
      }, ac),
    }, trigger),
    debug: bool(r.debug, d.debug),
  };
  const f = fake(r.fake);
  if (f) out.fake = f;
  return keepUnknown(out, r, ["fake"]);
}

/** Settings from the text of `settings.json`. `ok` is false when the text is not a JSON object (the defaults are
 *  returned then, and the caller should not write them over the owner's file). */
export function parseSettings(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, settings: defaultSettings() };
  }
  return { ok: isObject(raw), settings: normalizeSettings(raw) };
}

/** The text written to `settings.json`. */
export const serializeSettings = (settings) => `${JSON.stringify(settings, null, 2)}\n`;

/** Probe facts with the debug `fake` overrides applied; the facts unchanged unless `settings.debug` is true. */
export function applyFake(facts, settings) {
  const f = settings?.debug === true ? fake(settings.fake) : null;
  if (!f) return facts;
  const out = { ...facts };
  for (const key of ["ac", "percent", "thermal", "lidClosed"]) if (key in f) out[key] = f[key];
  return out;
}

// ── Runtime state (C2 runtime.json) ─────────────────────────────────────────────────────────────────────────────

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const pid = (v) => Number.isInteger(v) && v > 0;
const argv = (v) => Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string");

/** A valid session or null: `mode` on/agent/timer, `origin` user/trigger (trigger only for on/agent), `startedAt`
 *  a number, `endsAt` a number for timer sessions and null otherwise. */
export function normalizeSession(v) {
  if (!isObject(v) || !SESSION_MODES.includes(v.mode) || !ORIGINS.includes(v.origin) || !finite(v.startedAt)) return null;
  if (v.mode === "timer") {
    if (v.origin !== "user" || !finite(v.endsAt)) return null;
    return { mode: "timer", origin: "user", startedAt: v.startedAt, endsAt: v.endsAt };
  }
  return { mode: v.mode, origin: v.origin, startedAt: v.startedAt, endsAt: null };
}

/** `runtime.json` from any parsed value; anything invalid (or another `v`) reads as nothing recorded. */
export function normalizeRuntime(raw) {
  const r = isObject(raw) && raw.v === 1 ? raw : {};
  const h = r.holder;
  const k = r.keeper;
  const t = isObject(r.trigger) ? r.trigger : {};
  return {
    v: 1,
    session: normalizeSession(r.session),
    holder: isObject(h) && pid(h.pid) && argv(h.argv) && pid(h.appPid) ? { pid: h.pid, argv: [...h.argv], appPid: h.appPid } : null,
    keeper: isObject(k) && pid(k.pid) && argv(k.argv) ? { pid: k.pid, argv: [...k.argv] } : null,
    trigger: { suppressed: t.suppressed === true, lastAc: typeof t.lastAc === "boolean" ? t.lastAc : null },
  };
}

/** The `runtime.json` object for a reducer state (core/machine.js) and the engine's holder and keeper. */
export function toRuntime(state, holder = null, keeper = null) {
  return {
    v: 1,
    session: state?.session ? { ...state.session } : null,
    holder,
    keeper,
    trigger: { suppressed: state?.trigger?.suppressed === true, lastAc: typeof state?.trigger?.lastAc === "boolean" ? state.trigger.lastAc : null },
  };
}

// ── Commands (C1) ────────────────────────────────────────────────────────────────────────────────────────────────

/** Every fixed command name (plus `timer:<minutes>`, minutes an integer 1..1440). */
export const COMMANDS = Object.freeze([
  "toggle", "mode:off", "mode:on", "mode:agent", "timer:cancel",
  "display:on", "display:off", "display:toggle", "closed-lid:on", "closed-lid:off", "closed-lid:toggle",
  "menu", "refresh", "install", "uninstall",
]);

const SWITCH = ["on", "off", "toggle"];

/** A C1 command (`nextCommand()` text, optionally prefixed `herdr-caffeinate.`) as `{command, value}`, or null when
 *  unknown or malformed. `timer:<n>` gives `value` n (integer 1..1440, no sign or leading zero); `timer:cancel`
 *  gives "cancel"; `toggle`, `menu`, `refresh`, `install`, `uninstall` give null. */
export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const name = text.startsWith(`${MOD_ID}.`) ? text.slice(MOD_ID.length + 1) : text;
  if (["toggle", "menu", "refresh", "install", "uninstall"].includes(name)) return { command: name, value: null };
  const at = name.indexOf(":");
  if (at < 0) return null;
  const head = name.slice(0, at);
  const arg = name.slice(at + 1);
  if (head === "mode" && ["off", "on", "agent"].includes(arg)) return { command: "mode", value: arg };
  if ((head === "display" || head === "closed-lid") && SWITCH.includes(arg)) return { command: head, value: arg };
  if (head === "timer") {
    if (arg === "cancel") return { command: "timer", value: "cancel" };
    if (!/^[1-9][0-9]{0,3}$/.test(arg)) return null;
    const minutes = Number(arg);
    return minutes >= TIMER_MIN && minutes <= TIMER_MAX ? { command: "timer", value: minutes } : null;
  }
  return null;
}

// ── Shared state (C3) ────────────────────────────────────────────────────────────────────────────────────────────

const REASON_OF = { on: "user", agent: "agent", timer: "timer" };

/** The C3 object for a reducer state at `now`: `mode` is the session's mode (Off without one); `active` and
 *  `display` are what the Mac is held to (awake, display kept on); `reason` names why it is awake (null when not);
 *  `endsAt` is the timer's end; `closedLid` is the reducer's closed-lid view; `install` the engine's privilege. */
export function buildShared(state, install, now) {
  const session = state?.session ?? null;
  const active = state?.awake === true;
  const lid = state?.closedLid ?? {};
  return {
    v: SHARED_VERSION,
    at: now,
    mode: session ? session.mode : "off",
    active,
    reason: active && session ? (session.origin === "trigger" ? "trigger" : REASON_OF[session.mode]) : null,
    display: active && state.display === true,
    endsAt: session?.endsAt ?? null,
    closedLid: {
      wanted: lid.wanted === true,
      status: CLOSED_LID_STATUSES.includes(lid.status) ? lid.status : "off",
      blocked: lid.status === "blocked" && BLOCK_REASONS.includes(lid.blocked) ? lid.blocked : null,
    },
    install: { sudo: install?.sudo === true, failsafe: install?.failsafe === true },
  };
}

/** True when two C3 objects differ only in `at` (publish on change, never per tick). */
export function sameShared(a, b) {
  if (!isObject(a) || !isObject(b)) return false;
  return JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });
}
