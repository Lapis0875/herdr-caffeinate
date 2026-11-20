// Test sandboxes for the root-side scripts in mods/herdr-caffeinate/bin/.
//
// The shipped scripts call every tool by absolute path and touch fixed root
// paths. A test copies a script into a temporary directory and rewrites those
// absolute paths (`rewrite`) so tools resolve to fake tools that log each call
// (`writeFakes`) and root paths resolve inside the sandbox. Every script runs
// in its own session with no controlling terminal (`run`), so even a real sudo
// could never prompt.
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const BIN = fileURLToPath(new URL('../../mods/herdr-caffeinate/bin/', import.meta.url));
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const LABEL = 'io.github.lapis0875.herdr-caffeinate.failsafe';

// A fresh sandbox: `root` mirrors `/` for rewritten root paths, `fake` holds
// the fake tools, `world` holds what the fakes report and their call log.
export async function makeSandbox(prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  // The path is pasted into sh case patterns, sed scripts and single quotes.
  if (!/^[A-Za-z0-9/._-]+$/.test(root)) throw new Error(`unsafe temporary path: ${root}`);
  const sandbox = {root, fake: join(root, 'fake'), world: join(root, 'world')};
  await mkdir(sandbox.fake);
  await mkdir(sandbox.world);
  return {...sandbox, cleanup: () => rm(root, {recursive: true, force: true})};
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Replace whole absolute paths in one pass. A path ending in `/` is a prefix;
// any other path must not continue with a name character. Every `from` must
// occur, so a renamed path in a script fails the test instead of escaping it.
export function rewrite(text, pairs) {
  const map = new Map(pairs);
  const alternatives = pairs.map(([from]) => escapeRegExp(from) + (from.endsWith('/') ? '' : '(?![\\w.-])'));
  const pattern = new RegExp(`(?<![\\w.-])(?:${alternatives.join('|')})`, 'g');
  const seen = new Set();
  const out = text.replace(pattern, (match) => {
    seen.add(match);
    return map.get(match);
  });
  const missing = pairs.map(([from]) => from).filter((from) => !seen.has(from));
  if (missing.length) throw new Error(`rewrite: not found in the script: ${missing.join(', ')}`);
  return out;
}

// Copy bin/<name> into `dir`, rewritten with `pairs` (none for templates).
export async function copyBin(name, dir, pairs = []) {
  const text = await readFile(join(BIN, name), 'utf8');
  const dest = join(dir, name);
  await writeFile(dest, pairs.length ? rewrite(text, pairs) : text, {mode: 0o755});
  return dest;
}

// Fake tool bodies. Each fake first appends "<name> <args>" to $W/calls.
// $W is the world directory, $R the sandbox root.
const FAKES = {
  // SleepDisabled from $W/sd (absent: unreadable), battery text from $W/batt;
  // writes update $W/sd unless $W/pmset-write-fails exists.
  pmset: `case "$*" in
'-g')
  [ -f "$W/sd" ] || exit 1
  printf 'System-wide power settings:\\n SleepDisabled\\t\\t%s\\nCurrently in use:\\n standby              1\\n' "$(cat "$W/sd")" ;;
'-g batt')
  [ -f "$W/batt" ] && cat "$W/batt" ;;
'-a disablesleep 0' | '-a disablesleep 1')
  [ -f "$W/pmset-write-fails" ] && exit 1
  printf '%s\\n' "$3" >"$W/sd" ;;
sleepnow)
  echo 'Sleeping now...' ;;
*)
  echo "fake pmset: unexpected arguments: $*" >&2
  exit 64 ;;
esac`,
  ioreg: `[ "$*" = '-r -k AppleClamshellState -d 1' ] || { echo "fake ioreg: unexpected arguments: $*" >&2; exit 64; }
[ -f "$W/ioreg" ] && cat "$W/ioreg"`,
  sysctl: `[ "$*" = '-n kern.waketime' ] || { echo "fake sysctl: unexpected arguments: $*" >&2; exit 64; }
if [ -f "$W/waketime" ]; then cat "$W/waketime"; else echo 'sysctl: unknown oid' >&2; exit 1; fi`,
  date: `[ "$*" = '+%s' ] || { echo "fake date: unexpected arguments: $*" >&2; exit 64; }
cat "$W/now"`,
  stat: 'exec /usr/bin/stat "$@"',
  touch: 'exec /usr/bin/touch "$@"',
  rm: 'exec /bin/rm "$@"',
  // A denied password for every call ($W/sudo-denied), or a failure for calls
  // whose arguments contain the text in $W/sudo-fails; otherwise drop -n and
  // run the command. `-l <command>` succeeds when the sandbox's
  // /etc/sudoers.d/herdr-caffeinate allows exactly that command.
  sudo: `[ -f "$W/sudo-denied" ] && { echo 'Sorry, try again.' >&2; exit 1; }
if [ -f "$W/sudo-fails" ]; then
  case "$*" in *"$(cat "$W/sudo-fails")"*) echo "fake sudo: failing: $*" >&2; exit 1 ;; esac
fi
[ "$1" = -n ] && shift
if [ "$1" = -l ]; then
  shift
  rule=$(cat "$R/etc/sudoers.d/herdr-caffeinate" 2>/dev/null) || exit 1
  case "$rule," in *"NOPASSWD: $*,"* | *", $*,"*) printf '%s\\n' "$1"; exit 0 ;; esac
  exit 1
fi
exec "$@"`,
  id: `case "$*" in
-u) cat "$W/uid" ;;
-un) cat "$W/user" ;;
*) echo "fake id: unexpected arguments: $*" >&2; exit 64 ;;
esac`,
  // `visudo -c` checks the real system, so it is faked: it prints the text in
  // $W/visudo-c-warning to stderr and exits 1 when that file exists.
  // `-cf <file>` runs the real visudo unless the arguments contain the text
  // in $W/visudo-cf-fails.
  visudo: `if [ "$*" = -c ]; then
  echo '/etc/sudoers: parsed OK'
  if [ -f "$W/visudo-c-warning" ]; then
    cat "$W/visudo-c-warning" >&2
    exit 1
  fi
  exit 0
fi
if [ -f "$W/visudo-cf-fails" ]; then
  case "$*" in *"$(cat "$W/visudo-cf-fails")"*) echo "$2:1:5: syntax error" >&2; exit 1 ;; esac
fi
exec /usr/sbin/visudo "$@"`,
  // The real install without -o/-g (no chown as a user); fails when the
  // arguments contain the text in $W/install-fails.
  install: `if [ -f "$W/install-fails" ]; then
  case "$*" in *"$(cat "$W/install-fails")"*) echo "fake install: failing: $*" >&2; exit 71 ;; esac
fi
n=$#
while [ "$n" -gt 0 ]; do
  a=$1
  shift
  n=$((n - 1))
  case $a in
  -o | -g) shift; n=$((n - 1)) ;;
  *) set -- "$@" "$a" ;;
  esac
done
exec /usr/bin/install "$@"`,
  // Loaded state in $W/loaded. A bootstrap runs the daemon once (RunAtLoad):
  // it touches alive unless $W/daemon-silent exists.
  launchctl: `case $1 in
bootout)
  [ -f "$W/bootout-fails" ] && exit 5
  [ -f "$W/loaded" ] || exit 3
  rm -f "$W/loaded" ;;
enable) ;;
bootstrap)
  [ -f "$W/bootstrap-fails" ] && { echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; }
  : >"$W/loaded"
  [ -f "$W/daemon-silent" ] || touch "$R/var/db/herdr-caffeinate/alive" ;;
print)
  [ -f "$W/loaded" ] || exit 113 ;;
*)
  echo "fake launchctl: unexpected arguments: $*" >&2
  exit 64 ;;
esac`,
  sleep: ':',
};

export async function writeFakes(sandbox, names) {
  for (const name of names) {
    const body = FAKES[name];
    if (body === undefined) throw new Error(`no fake for ${name}`);
    const text = `#!/bin/sh\nW='${sandbox.world}'\nR='${sandbox.root}'\nprintf '%s\\n' "${name} $*" >>"$W/calls"\n${body}\n`;
    await writeFile(join(sandbox.fake, name), text, {mode: 0o755});
  }
}

// Write world files for the fakes; a null value removes the file.
export async function setWorld(sandbox, files) {
  for (const [name, text] of Object.entries(files)) {
    if (text === null) await rm(join(sandbox.world, name), {force: true});
    else await writeFile(join(sandbox.world, name), text);
  }
}

// The fake-tool call log, one string per call, with sandbox paths shortened:
// `<root>/fake/` is dropped and `<root>` stripped, so a call reads like
// `sudo install -d -o root -g wheel -m 0755 /var/db/herdr-caffeinate`.
export async function readCalls(sandbox) {
  let text = '';
  try {
    text = await readFile(join(sandbox.world, 'calls'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return text.split('\n').filter(Boolean).map((line) => line.replaceAll(`${sandbox.fake}/`, '').replaceAll(sandbox.root, ''));
}

export const clearCalls = (sandbox) => rm(join(sandbox.world, 'calls'), {force: true});

// Run argv in a new session (no controlling terminal) with a minimal env.
export function run(argv, {env = {}, timeout = 30_000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: {PATH: SYSTEM_PATH, LC_ALL: 'C', ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal, stdout, stderr});
    });
  });
}
