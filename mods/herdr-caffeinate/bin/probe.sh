#!/bin/sh
# herdr-caffeinate probe (docs/CONTRACTS.md C5): bin/probe.sh [--thermal]
# Read-only. Prints raw tool output in @@ sections for core/probe-parse.js, does no
# parsing and always exits 0; an unreadable fact leaves its section or value empty.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
LC_ALL=C
export PATH LC_ALL

thermal=
for arg in "$@"; do
  if [ "$arg" = --thermal ]; then thermal=1; fi
done

# section <name> <command…>: header line, then the command's stdout ending in one newline,
# so the next header always starts its own line; stderr is dropped.
section() {
  name=$1
  shift
  printf '@@%s\n' "$name"
  out=$("$@" 2>/dev/null)
  if [ -n "$out" ]; then printf '%s\n' "$out"; fi
}

battery() { /usr/bin/pmset -g batt; }
sleep_disabled() { /usr/bin/pmset -g | /usr/bin/grep SleepDisabled; }
clamshell() {
  /usr/sbin/ioreg -r -k AppleClamshellState -d 1 | /usr/bin/grep -E '"AppleClamshell(State|CausesSleep)"'
}
thermal_state() {
  /usr/bin/osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState'
}

# mtime <path>: epoch seconds of a regular, non-symlink file, or nothing.
mtime() {
  if [ -f "$1" ] && [ ! -h "$1" ]; then /usr/bin/stat -f %m "$1" 2>/dev/null; fi
}

stamps() {
  claim=
  if [ -n "${HOME:-}" ]; then claim=$(mtime "$HOME/.herdr/herdr-caffeinate/claim"); fi
  printf 'alive=%s\n' "$(mtime /var/db/herdr-caffeinate/alive)"
  printf 'claim=%s\n' "$claim"
  printf 'restore=%s\n' "$(mtime /var/db/herdr-caffeinate/last-restore)"
  printf 'now=%s\n' "$(/bin/date +%s 2>/dev/null)"
}

section batt battery
section pmset sleep_disabled
section lid clamshell
if [ -n "$thermal" ]; then section thermal thermal_state; fi
section stat stamps
exit 0
