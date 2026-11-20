// The caffeinate holder (C11, S1): one detached `/usr/bin/caffeinate -i -s [-d] -w <Herdr pid> [-t <seconds>]`
// started through `nohup` from an `exec`'d `/bin/sh`, so it outlives the `exec`, a mod reload and the copy, and
// ends with Herdr through `-w`. A process is killed only after `ps` shows exactly the argv we launched for that pid.

export const CAFFEINATE = "/usr/bin/caffeinate";
export const PS = "/bin/ps";
export const KILL = "/bin/kill";

/** S1 launch form: `$!` is the utility's own pid (nohup execs it); output goes to /dev/null so `exec` returns at
 *  once. Run as `exec("/bin/sh", ["-c", DETACH, "sh", ...argv])`. */
export const DETACH = 'nohup "$@" >/dev/null 2>&1 & echo "$!"';

/** The Herdr pid is `$PPID` of an `exec`'d shell (S1); its command line identifies other Herdr instances. */
export const HERDR_PID = 'echo "$PPID"; /bin/ps -o command= -p "$PPID"';

const EXEC_TIMEOUT_MS = 10000;

const isPid = (v) => Number.isInteger(v) && v > 1;

/** The holder argv: `-d` keeps the display awake, `seconds` (timer sessions only) adds `-t <seconds>`. */
export function holderArgv(appPid, { display = false, seconds = null } = {}) {
  return [
    CAFFEINATE, "-i", "-s",
    ...(display ? ["-d"] : []),
    "-w", String(appPid),
    ...(Number.isInteger(seconds) && seconds > 0 ? ["-t", String(seconds)] : []),
  ];
}

/** Whole seconds from `now` until `endsAt` (ms), at least 1. */
export const secondsLeft = (endsAt, now) => Math.max(1, Math.ceil((endsAt - now) / 1000));

/** What a holder argv asks for: `{display, timed, appPid}`, or null when it is not exactly a holder argv. */
export function holderKind(argv) {
  if (!Array.isArray(argv)) return null;
  const m = /^\/usr\/bin\/caffeinate -i -s( -d)? -w ([1-9][0-9]*)( -t [1-9][0-9]*)?$/.exec(argv.join(" "));
  return m ? { display: Boolean(m[1]), appPid: Number(m[2]), timed: Boolean(m[3]) } : null;
}

/** True when a `ps` command line is exactly a holder of this Herdr (`-w <appPid>`), the orphan rule of C11. */
export function isHolderCommand(command, appPid) {
  const kind = holderKind(typeof command === "string" ? command.split(" ") : null);
  return kind !== null && kind.appPid === appPid;
}

/** This Herdr's pid and command line, or null. */
export async function herdrProcess(exec) {
  try {
    const r = await exec("/bin/sh", ["-c", HERDR_PID], { timeout: EXEC_TIMEOUT_MS });
    const [pidLine = "", command = ""] = String(r?.stdout ?? "").split("\n");
    const pid = Number(pidLine.trim());
    return r?.code === 0 && isPid(pid) ? { pid, command: command.trim() } : null;
  } catch {
    return null;
  }
}

/** Starts `argv` detached (S1). Returns its pid, or null when the launch failed. */
export async function launch(exec, argv) {
  try {
    const r = await exec("/bin/sh", ["-c", DETACH, "sh", ...argv], { timeout: EXEC_TIMEOUT_MS });
    const pid = Number(String(r?.stdout ?? "").trim());
    return r?.code === 0 && isPid(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** `ps -o command= -p <pid>`: the process's command line, or null when it is gone or unreadable. */
export async function commandOf(exec, pid) {
  if (!isPid(pid)) return null;
  try {
    const r = await exec(PS, ["-o", "command=", "-p", String(pid)], { timeout: EXEC_TIMEOUT_MS });
    const command = String(r?.stdout ?? "").trim();
    return r?.code === 0 && command !== "" ? command : null;
  } catch {
    return null;
  }
}

/** True when `command` is the launched `argv`. Right after a launch `ps` may still show `nohup <argv>` (S1 fact 2),
 *  which is the same process before nohup execs the utility. */
export function sameArgv(command, argv) {
  const line = argv.join(" ");
  return command === line || command === `nohup ${line}`;
}

/** True when `pid` still runs `argv`. */
export async function runs(exec, pid, argv) {
  const command = await commandOf(exec, pid);
  return command !== null && sameArgv(command, argv);
}

/** Kills `pid` (TERM) only after `ps` shows exactly `argv` for it. Returns "killed", "gone" (no such process) or
 *  "mismatch" (another program has that pid now: left alone). */
export async function killVerified(exec, pid, argv) {
  const command = await commandOf(exec, pid);
  if (command === null) return "gone";
  if (!sameArgv(command, argv)) return "mismatch";
  try {
    const r = await exec(KILL, [String(pid)], { timeout: EXEC_TIMEOUT_MS });
    return r?.code === 0 ? "killed" : "gone";
  } catch {
    return "gone";
  }
}

/** Polls (every 50 ms, at most 1 s) until `$1` has exited. Run as `exec("/bin/sh", ["-c", WAIT_GONE, "sh", pid])`. */
export const WAIT_GONE = 'i=0; while /bin/kill -0 "$1" 2>/dev/null; do [ "$i" -ge 20 ] && exit 1; /bin/sleep 0.05; i=$((i + 1)); done';

/** Waits until a killed `pid` has exited, so its assertions are released (D7: before `pmset sleepnow`). True when it
 *  has. */
export async function waitGone(exec, pid) {
  try {
    const r = await exec("/bin/sh", ["-c", WAIT_GONE, "sh", String(pid)], { timeout: EXEC_TIMEOUT_MS });
    return r?.code === 0;
  } catch {
    return false;
  }
}

/** Every process as `{pid, command}` (`ps -axo pid=,command=`); [] when unreadable. */
export async function listProcesses(exec) {
  try {
    const r = await exec(PS, ["-axo", "pid=,command="], { timeout: EXEC_TIMEOUT_MS });
    if (r?.code !== 0) return [];
    const out = [];
    for (const line of String(r.stdout ?? "").split("\n")) {
      const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
      if (m) out.push({ pid: Number(m[1]), command: m[2] });
    }
    return out;
  } catch {
    return [];
  }
}

/** Boot sweep (C11): kills every process except `keepPid` whose command line is exactly a holder of `appPid`
 *  (an orphan of a reload that lost its launch result), each after its argv is checked again. Returns the pids
 *  killed. */
export async function sweepOrphans(exec, appPid, keepPid = null) {
  const killed = [];
  for (const { pid, command } of await listProcesses(exec)) {
    // Right after a launch `ps` may still show `nohup <argv>` (S1 fact 2): the same process before it execs.
    const line = command.startsWith("nohup ") ? command.slice(6) : command;
    if (pid === keepPid || !isHolderCommand(line, appPid)) continue;
    if ((await killVerified(exec, pid, line.split(" "))) === "killed") killed.push(pid);
  }
  return killed;
}
