// Closed-lid privilege (C6): the only privileged commands the mod runs, and the `install` facts it reports.
// `install.sudo`: `sudo -n -l /usr/bin/pmset -a disablesleep 0` and `… 1` both exit 0 (never prompts).
// `install.failsafe`: the watchdog's `alive` file is 0..60 s old (a negative age, an mtime ahead of the clock, is
// not fresh).

import { FAILSAFE_FRESH_SEC } from "../core/state.js";

export const SUDO = "/usr/bin/sudo";
export const PMSET = "/usr/bin/pmset";

const SUDO_TIMEOUT_MS = 10000;

/** The argv after `sudo` for `pmset -a disablesleep <0|1>`. */
export const disableSleepArgs = (on) => [PMSET, "-a", "disablesleep", on ? "1" : "0"];

async function exitsZero(exec, args) {
  try {
    const r = await exec(SUDO, args, { timeout: SUDO_TIMEOUT_MS });
    return r?.code === 0;
  } catch {
    return false;
  }
}

/** `install.sudo`: both rule lines may run without a password. */
export async function checkSudo(exec) {
  const [off, on] = await Promise.all([
    exitsZero(exec, ["-n", "-l", ...disableSleepArgs(false)]),
    exitsZero(exec, ["-n", "-l", ...disableSleepArgs(true)]),
  ]);
  return off && on;
}

/** `install.failsafe` from the probe's `failsafeAliveAge` (seconds). */
export function failsafeFresh(age) {
  return typeof age === "number" && Number.isFinite(age) && age >= 0 && age <= FAILSAFE_FRESH_SEC;
}

/** `sudo -n /usr/bin/pmset -a disablesleep <0|1>`; true when it exited 0 (non-zero: not permitted). */
export function setDisableSleep(exec, on) {
  return exitsZero(exec, ["-n", ...disableSleepArgs(on)]);
}
