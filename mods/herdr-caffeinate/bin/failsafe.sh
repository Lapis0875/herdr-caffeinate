#!/bin/sh
# herdr-caffeinate root fail-safe (docs/CONTRACTS.md C7).
#
# install.sh copies this file to
#   /Library/PrivilegedHelperTools/io.github.lapis0875.herdr-caffeinate.failsafe
# and launchd runs it as root every 15 s:
#   /bin/sh <helper> /Users/<user>/.herdr/herdr-caffeinate/claim
#
# The claim is a file Herdr keeps touching while it holds `disablesleep 1`.
# While the claim is fresh and SleepDisabled is 1 the watchdog arms itself.
# It restores `pmset -a disablesleep 0` when the claim goes stale (Herdr died
# or hangs), when the claim disappears while armed, or when an armed Mac runs
# on battery below FLOOR %. With no claim and nothing armed it never changes
# SleepDisabled, so a `disablesleep 1` set by another tool is left alone.
#
# It reads only the claim's lstat mtime, never follows or writes anything in
# the user's home, and writes only under STATE (root-owned, world-readable):
#   alive         touched on every run with a valid argument
#   armed         exists while SleepDisabled 1 was seen under a fresh claim
#   handled       mtime of the last stale claim already restored
#   last-restore  "<epoch> <reason>", reason battery-floor|stale-claim|claim-gone
#
# Exit: 0 done; 1 a restore could not complete (state kept, the next run
# retries); 64 rejected argument (nothing read or written).
#
# Every external tool is called by absolute path. tests/failsafe.test.mjs runs
# a temporary copy in which these paths point at fake tools.

set -u
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL

STALE=45
WAKE_GRACE=60
FLOOR=10
STATE=/var/db/herdr-caffeinate

NL='
'
TAB=$(printf '\t')

# is_uint VALUE: VALUE is a non-empty string of decimal digits.
is_uint() {
	case $1 in
	'' | *[!0-9]*) return 1 ;;
	esac
	return 0
}

# read_sleep_disabled: sets SD to 0 or 1 from the ` SleepDisabled<tabs><n>`
# line of `pmset -g`, or to empty when it cannot be read.
read_sleep_disabled() {
	SD=
	out=$(/usr/bin/pmset -g 2>/dev/null) || return 0
	case $out in
	*SleepDisabled*) ;;
	*) return 0 ;;
	esac
	rest=${out#*SleepDisabled}
	while :; do
		case $rest in
		" "* | "$TAB"*) rest=${rest#?} ;;
		*) break ;;
		esac
	done
	case $rest in
	0 | 0[!0-9]*) SD=0 ;;
	1 | 1[!0-9]*) SD=1 ;;
	esac
}

# battery_below_floor: true when `pmset -g batt` reports Battery Power and its
# first percentage is below FLOOR. Unreadable output counts as false.
battery_below_floor() {
	out=$(/usr/bin/pmset -g batt 2>/dev/null) || return 1
	case $out in
	*"'Battery Power'"*) ;;
	*) return 1 ;;
	esac
	case $out in
	*"%;"*) ;;
	*) return 1 ;;
	esac
	pct=${out%%"%;"*}
	pct=${pct##*[!0-9]}
	is_uint "$pct" || return 1
	[ "$pct" -lt "$FLOOR" ]
}

# woke_recently: true only when 0 <= NOW - kern.waketime < WAKE_GRACE.
# Format (docs/spikes/S4.md): `{ sec = <epoch>, usec = <n> } <ctime>`.
# A missing, malformed or zero wake time, or a wall clock set back before
# it, grants no grace.
woke_recently() {
	w=$(/usr/sbin/sysctl -n kern.waketime 2>/dev/null) || return 1
	case $w in
	*"sec = "*) ;;
	*) return 1 ;;
	esac
	w=${w#*sec = }
	w=${w%%,*}
	is_uint "$w" || return 1
	[ "$w" -gt 0 ] || return 1
	since=$((NOW - w))
	[ "$since" -ge 0 ] && [ "$since" -lt "$WAKE_GRACE" ]
}

# lid_shut_and_causes_sleep: true when IOPMrootDomain reports both
# `"AppleClamshellState" = Yes` and `"AppleClamshellCausesSleep" = Yes`.
# A missing key counts as No.
lid_shut_and_causes_sleep() {
	out=$(/usr/sbin/ioreg -r -k AppleClamshellState -d 1 2>/dev/null) || return 1
	out=$out$NL
	case $out in
	*"\"AppleClamshellState\" = Yes$NL"*) ;;
	*) return 1 ;;
	esac
	case $out in
	*"\"AppleClamshellCausesSleep\" = Yes$NL"*) return 0 ;;
	esac
	return 1
}

# restore REASON (C7 step 5). Writes `disablesleep 0` only when SleepDisabled
# reads 1. Fails without touching any state file when SleepDisabled cannot be
# read or the write fails, so the next run tries again.
restore() {
	read_sleep_disabled
	case $SD in
	1) /usr/bin/pmset -a disablesleep 0 || return 1 ;;
	0) ;;
	*) return 1 ;;
	esac
	/bin/rm -f "$STATE/armed"
	printf '%s %s\n' "$NOW" "$1" >"$STATE/last-restore"
	if lid_shut_and_causes_sleep; then
		/usr/bin/pmset sleepnow
	fi
	return 0
}

# Step 1: accept only /Users/<name>/.herdr/herdr-caffeinate/claim, where
# <name> is one path segment of [A-Za-z0-9._-], not starting with a dot.
[ "$#" -eq 1 ] || exit 64
CLAIM=$1
case $CLAIM in
/Users/*/.herdr/herdr-caffeinate/claim) ;;
*) exit 64 ;;
esac
NAME=${CLAIM#/Users/}
NAME=${NAME%/.herdr/herdr-caffeinate/claim}
case $NAME in
'' | .* | *..* | *[!A-Za-z0-9._-]*) exit 64 ;;
esac

NOW=$(/bin/date +%s)
is_uint "$NOW" || exit 1
/usr/bin/touch "$STATE/alive"

# A claim counts only as a regular file that is not a symlink. `stat -f %m`
# without -L reads the link itself, so a swap after the test stays harmless.
MTIME=
if [ ! -L "$CLAIM" ] && [ -f "$CLAIM" ]; then
	MTIME=$(/usr/bin/stat -f %m "$CLAIM" 2>/dev/null) || MTIME=
	is_uint "$MTIME" || MTIME=
fi

# Step 4: no claim. Restore only what this watchdog armed.
if [ -z "$MTIME" ]; then
	if [ -e "$STATE/armed" ]; then
		restore claim-gone || exit 1
	fi
	exit 0
fi

# Step 2: fresh claim. A claim dated in the future (wall clock set back) is
# treated as stale, like the wake time above.
AGE=$((NOW - MTIME))
if [ "$AGE" -ge 0 ] && [ "$AGE" -le "$STALE" ]; then
	read_sleep_disabled
	if [ "$SD" = 1 ] && [ ! -e "$STATE/armed" ]; then
		: >"$STATE/armed"
	fi
	if [ -e "$STATE/armed" ] && battery_below_floor; then
		restore battery-floor || exit 1
	fi
	exit 0
fi

# Step 3: stale claim, restored once per claim mtime and not right after a wake.
HANDLED=
if [ -f "$STATE/handled" ]; then
	IFS= read -r HANDLED <"$STATE/handled" || :
fi
[ "$HANDLED" = "$MTIME" ] && exit 0
woke_recently && exit 0
restore stale-claim || exit 1
printf '%s\n' "$MTIME" >"$STATE/handled"
exit 0
