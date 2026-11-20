// Closed-lid (C4, C11): the claim file and `pmset -a disablesleep`.
// The claim `~/.herdr/herdr-caffeinate/claim` (0600 in a 0700 dir) exists while this user's Herdr set
// `disablesleep 1`; its mtime is the heartbeat the root watchdog (C7) checks. `fs/promises` writes only under the
// app home, so the claim is created, touched and removed only through `exec`.
//
// Engage:    if SleepDisabled is 1 and we hold no claim → "external", touch nothing; else write the claim,
//            `sudo -n pmset -a disablesleep 1`, read back; on failure turn it back to 0 (when the set ran), remove
//            the claim → "unavailable".
// Disengage: `sudo -n pmset -a disablesleep 0`, read back, remove the claim, `pmset sleepnow` when asked (D7).

import { claimPath, runtimeDir } from "../core/state.js";
import { readSleepDisabled } from "./probe.js";
import { PMSET, setDisableSleep } from "./privilege.js";

export const TOUCH = "/usr/bin/touch";
export const RM = "/bin/rm";

/** Writes `$3` as the claim `$2` in the dir `$1` (0700): through a temp file and `mv`, which replaces a symlink
 *  instead of following it. Run as `exec("/bin/sh", ["-c", WRITE_CLAIM, "sh", dir, claim, text])`. */
export const WRITE_CLAIM =
  'umask 077; /bin/mkdir -p "$1" && /bin/chmod 700 "$1" && printf "%s\\n" "$3" > "$2.tmp" && /bin/mv -f "$2.tmp" "$2"';

const EXEC_TIMEOUT_MS = 10000;

/** The claim's content (read only by the mod): `{v:1, owner:{pid, appHome}, since}`, `since` epoch ms. */
export const claimText = (pid, appHome, since) => JSON.stringify({ v: 1, owner: { pid, appHome }, since });

/** The claim's owner: `{pid, appHome, since}`, or null when the text is not a v1 claim. */
export function parseClaim(text) {
  try {
    const c = JSON.parse(text);
    const pid = c?.owner?.pid;
    if (c?.v !== 1 || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      appHome: typeof c.owner.appHome === "string" ? c.owner.appHome : null,
      since: typeof c.since === "number" && Number.isFinite(c.since) ? c.since : null,
    };
  } catch {
    return null;
  }
}

async function ok(exec, command, args) {
  try {
    const r = await exec(command, args, { timeout: EXEC_TIMEOUT_MS });
    return r?.code === 0;
  } catch {
    return false;
  }
}

/** Creates or replaces the claim with `text`. */
export const writeClaim = (exec, home, text) =>
  ok(exec, "/bin/sh", ["-c", WRITE_CLAIM, "sh", runtimeDir(home), claimPath(home), text]);

/** Refreshes the claim's mtime; never creates it. */
export const touchClaim = (exec, home) => ok(exec, TOUCH, ["-c", claimPath(home)]);

/** Removes the claim. */
export const removeClaim = (exec, home) => ok(exec, RM, ["-f", claimPath(home)]);

/** `pmset sleepnow` (D7). */
export const sleepNow = (exec) => ok(exec, PMSET, ["sleepnow"]);

/** C11 engage. `held`: we hold the claim already (a re-engage). Returns "engaged", "external" or "unavailable". */
export async function engage(exec, { home, text, held }) {
  if (!held && (await readSleepDisabled(exec)) === true) return "external";
  if (!(await writeClaim(exec, home, text))) return "unavailable";
  const set = await setDisableSleep(exec, true);
  if (set && (await readSleepDisabled(exec)) === true) return "engaged";
  // The set did not take, or its result can't be read: fail toward a Mac that can sleep.
  if (set) await setDisableSleep(exec, false);
  await removeClaim(exec, home);
  return "unavailable";
}

/** C11 disengage. Returns `SleepDisabled` as read back afterwards (false: restored; true or null: not), which is the
 *  engine's fact from then on. The claim is removed either way: with `disablesleep 1` left, the armed watchdog restores
 *  it (`claim-gone`). */
export async function disengage(exec, { home, sleep = false }) {
  await setDisableSleep(exec, false);
  const after = await readSleepDisabled(exec);
  await removeClaim(exec, home);
  if (sleep) await sleepNow(exec);
  return after;
}
