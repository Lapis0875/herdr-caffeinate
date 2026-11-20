// Probe runner (C5): runs `bin/probe.sh [--thermal]` and parses it with core/probe-parse.js, and reads the
// `SleepDisabled` line alone for the closed-lid read-back (C11). Unreadable output gives null facts; nothing throws.

import { MOD_ID } from "../core/state.js";
import { parseProbe } from "../core/probe-parse.js";

const PROBE_TIMEOUT_MS = 15000;
const READBACK_TIMEOUT_MS = 5000;

/** The `SleepDisabled` line of `pmset -g`, as `bin/probe.sh` prints it under `@@pmset`. */
export const SLEEP_DISABLED_SH = "/usr/bin/pmset -g | /usr/bin/grep SleepDisabled";

/** `<app home>/mods/herdr-caffeinate/bin/probe.sh`. */
export const probeScript = (appHome) => `${String(appHome).replace(/\/+$/, "")}/mods/${MOD_ID}/bin/probe.sh`;

/** One probe: the C5 facts (`parseProbe`), all null when the script can't run. `thermal` adds `@@thermal`
 *  (S4: read whenever closed-lid is enabled). */
export async function runProbe(exec, appHome, { thermal = false } = {}) {
  let text = null;
  try {
    const r = await exec("/bin/sh", [probeScript(appHome), ...(thermal ? ["--thermal"] : [])], { timeout: PROBE_TIMEOUT_MS });
    text = r?.stdout ?? null;
  } catch {
    text = null;
  }
  return parseProbe(text);
}

/** `SleepDisabled` now: true (1), false (0) or null when unreadable. */
export async function readSleepDisabled(exec) {
  try {
    const r = await exec("/bin/sh", ["-c", SLEEP_DISABLED_SH], { timeout: READBACK_TIMEOUT_MS });
    return parseProbe(`@@pmset\n${r?.stdout ?? ""}`).sleepDisabled;
  } catch {
    return null;
  }
}
