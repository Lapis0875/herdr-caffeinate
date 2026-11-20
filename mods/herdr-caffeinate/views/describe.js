// What the chip and the menu show for an engine snapshot (sys/engine.js `snapshot()`), as words in the current
// language. Pure apart from `t()`: callers pass the snapshot and `now`.
//
// Phases: `starting` (no engine run in this build yet, or no C3 published), `off` (mode Off), `waiting` (Agent mode
// with no agent working: armed, not holding), `active` (the Mac is held awake). They map 1:1 to the `status` tones
// of ui/tokens.js.

import { BLOCK_REASONS, CLOSED_LID_STATUSES, MODES, SHARED_VERSION } from "../core/state.js";
import { formatUntil, remainingMs } from "../core/format.js";
import { t } from "../core/i18n.js";
import { GLYPH } from "../ui/icons.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The C3 object the views may trust: the engine runs in this build and published a version-1 state. */
function usableShared(snap) {
  const s = snap?.running ? snap.shared : null;
  return isObj(s) && s.v === SHARED_VERSION && MODES.includes(s.mode) && typeof s.active === "boolean" ? s : null;
}

/**
 * The view model: `{phase, mode, reason, active, display, endsAt, lid: {status, blocked, wanted}, install, settings,
 * settingsOk}`. `settings` is null while the engine does not run (controls are disabled then); `install` is
 * `{sudo, failsafe}` or null while unknown.
 */
export function look(snap) {
  const s = usableShared(snap);
  const settings = snap?.running && isObj(snap.settings) ? snap.settings : null;
  const installRaw = snap?.install ?? s?.install ?? null;
  const install = isObj(installRaw) ? { sudo: installRaw.sudo === true, failsafe: installRaw.failsafe === true } : null;
  if (!s) {
    return { phase: "starting", mode: null, reason: null, active: false, display: false, endsAt: null, lid: null, install, settings, settingsOk: snap?.settingsOk !== false };
  }
  const lidRaw = isObj(s.closedLid) ? s.closedLid : {};
  const status = CLOSED_LID_STATUSES.includes(lidRaw.status) ? lidRaw.status : "off";
  const blocked = status === "blocked" ? (BLOCK_REASONS.includes(lidRaw.blocked) ? lidRaw.blocked : "unknown") : null;
  return {
    phase: s.active ? "active" : s.mode === "agent" ? "waiting" : "off",
    mode: s.mode,
    reason: s.active ? s.reason : null,
    active: s.active,
    display: s.active && s.display === true,
    endsAt: s.mode === "timer" && Number.isFinite(s.endsAt) ? s.endsAt : null,
    lid: { status, blocked, wanted: lidRaw.wanted === true },
    install,
    settings,
    settingsOk: snap?.settingsOk !== false,
  };
}

/** Whole minutes left of a timer, rounded up and at least 1; null without one. */
export function minutesLeft(L, now) {
  const ms = remainingMs(L?.endsAt, now);
  return ms === null ? null : Math.max(1, Math.ceil(ms / 60000));
}

/** A duration in minutes as words: "45 min", "1 h", "1 h 5 min" (ko: "45분", "1시간", "1시간 5분"). */
export function minutesLabel(n) {
  if (!Number.isInteger(n) || n < 60) return t("timer.minutes", { n });
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? t("timer.hoursMinutes", { h, m }) : t("timer.hours", { n: h });
}

/** The countdown of a running timer ("41:59", "1:05:00"), or "" without one. */
export function countdown(L, now) {
  return L?.endsAt == null ? "" : formatUntil(L.endsAt, now);
}

/** The mode word for the header and the chip (`mode.*`); null while starting. */
export function modeWord(L) {
  return L.mode ? t(`mode.${L.mode}`) : null;
}

/** One line saying what keeps the Mac awake, or not (`chip.*`). `time` fills the timer line. */
export function stateLine(L, time) {
  if (L.phase === "starting") return t("chip.starting");
  if (L.phase === "off") return t("chip.off");
  if (L.phase === "waiting") return t("chip.agent.idle");
  if (L.reason === "trigger") return t("chip.trigger");
  if (L.mode === "timer") return t("chip.timer", { time });
  if (L.mode === "agent") return t("chip.agent.active");
  return t("chip.on");
}

/** Which install state the closed-lid helper is in (`install.state.<key>`). */
export function installKey(install) {
  if (!install) return "checking";
  if (install.sudo && install.failsafe) return "installed";
  if (!install.sudo && !install.failsafe) return "missing";
  return install.sudo ? "noFailsafe" : "noSudo";
}

/** Why closed-lid is paused, in words (`lid.block.*`); the battery reason names the floor. */
export function blockReason(blocked, settings) {
  const floor = settings?.closedLid?.batteryFloor;
  return t(`lid.block.${blocked ?? "unknown"}`, { floor: floor ?? "" });
}

/**
 * The closed-lid status line for the menu: `{tone, glyph, text}`. tone is a ui/tokens.js `status` key (`off`,
 * `engaged`, `blocked`, `unavailable`, `external`); glyph a ui/icons.js icon name (GLYPH.closedLidStatus, or the
 * block reason's GLYPH.blocked glyph).
 */
export function lidStatus(L) {
  const enabled = L.settings?.closedLid?.enabled === true;
  const status = L.lid?.status ?? "off";
  const glyph = GLYPH.closedLidStatus[status] ?? GLYPH.closedLid;
  if (status === "engaged") return { tone: "engaged", glyph, text: t("menu.lid.status", { status: t("lid.status.engaged") }) };
  if (status === "blocked") {
    return { tone: "blocked", glyph: GLYPH.blocked[L.lid.blocked] ?? GLYPH.blocked.unknown, text: t("lid.paused", { reason: blockReason(L.lid.blocked, L.settings) }) };
  }
  if (status === "external") return { tone: "external", glyph, text: t("lid.block.external") };
  if (status === "unavailable") {
    const key = installKey(L.install);
    const why = key === "installed" ? t("lid.block.unavailable") : t(`install.state.${key}`);
    return { tone: "unavailable", glyph, text: `${t("menu.lid.status", { status: t("lid.status.unavailable") })} · ${why}` };
  }
  if (enabled) return { tone: "off", glyph, text: t("lid.waiting") };
  return { tone: "off", glyph, text: t("menu.lid.status", { status: t("lid.status.off") }) };
}

/** The chip's closed-lid lines: `chip.lid` with the status, then the block reason while blocked; none while off. */
export function chipLidLines(L) {
  const status = L.lid?.status ?? "off";
  if (status === "off") return [];
  const lines = [t("chip.lid", { status: t(`lid.status.${status}`) })];
  if (status === "blocked") lines.push(blockReason(L.lid.blocked, L.settings));
  return lines;
}

/** The chip's tooltip and accessibility label: the state line, the display, closed-lid, then how to open the menu. */
export function chipTip(L, now) {
  const minutes = minutesLeft(L, now);
  const lines = [stateLine(L, minutes === null ? "" : minutesLabel(minutes))];
  if (L.display) lines.push(t("chip.display"));
  lines.push(...chipLidLines(L), t("chip.open"));
  return lines.join("\n");
}

/** The chip's words when it has room: the time left of a timer, the mode while awake or waiting, else none. */
export function chipLabel(L, now) {
  if (L.phase === "starting" || L.phase === "off") return null;
  if (L.mode === "timer") {
    const minutes = minutesLeft(L, now);
    return minutes === null ? modeWord(L) : minutesLabel(minutes);
  }
  return modeWord(L);
}
