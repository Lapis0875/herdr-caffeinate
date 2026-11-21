#!/bin/sh
# herdr-caffeinate uninstaller (docs/CONTRACTS.md C8).
#
# Run as yourself, not as root (Herdr runs it in a tab); it calls sudo for
# each privileged step:
#   /bin/sh uninstall.sh
# 1. When Herdr's claim (~/.herdr/herdr-caffeinate/claim) exists, or the
#    watchdog's `armed` file exists without a `released`
#    (~/.herdr/herdr-caffeinate/released) at least as new, closed-lid may be
#    on: restore `pmset -a disablesleep 0` unless SleepDisabled already reads
#    0. A newer `released` means Herdr's own disengage already restored 0, so
#    a `disablesleep 1` now belongs to another tool (failsafe.sh step 4).
# 2. Stop the daemon (`launchctl bootout`).
# 3. Remove the plist, the helper, /var/db/herdr-caffeinate and the sudoers
#    file.
# 4. Remove the claim and `released` (only those files;
#    ~/.herdr/herdr-caffeinate/ stays). A claim left behind is a stale claim
#    the next install's watchdog has not handled (`handled` goes with the
#    state directory), so that watchdog would turn off a `disablesleep 1` set
#    by another tool.
# 5. Check that each path is gone and the daemon is not loaded.
#    A whole-config `sudo visudo -c` runs only to print other files'
#    findings as notes (Amphetamine's 0644 amphetamine_PowerProtect fails
#    it while sudo still reads it); it never changes the exit code.
# 6. Say so when SleepDisabled is still 1, set by another tool.
#
# Exit: 0 everything removed; 1 refused (root, invalid user or home);
# 40 something is left, or the disablesleep restore failed.

set -u
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL

LABEL=io.github.lapis0875.herdr-caffeinate.failsafe
SUDOERS=/etc/sudoers.d/herdr-caffeinate
HELPER=/Library/PrivilegedHelperTools/$LABEL
PLIST=/Library/LaunchDaemons/$LABEL.plist
STATE=/var/db/herdr-caffeinate

TAB=$(printf '\t')

say() {
	printf '%s\n' "$*"
}

warn() {
	printf 'herdr-caffeinate uninstall: %s\n' "$*" >&2
}

fail() {
	code=$1
	shift
	warn "$*"
	exit "$code"
}

# valid_user and valid_home: the same rules as install.sh.
valid_user() {
	case $1 in
	'' | [!a-z_]* | *[!a-z0-9_-]*) return 1 ;;
	esac
	return 0
}

valid_home() {
	case $1 in
	/Users/*) ;;
	*) return 1 ;;
	esac
	name=${1#/Users/}
	case $name in
	'' | .* | *..* | *[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

# visudo_notes HEADER: the same as in install.sh.
visudo_notes() {
	report=$(/usr/bin/sudo -n /usr/sbin/visudo -c 2>&1) || :
	header=$1
	while IFS= read -r line; do
		case $line in
		'' | *': parsed OK') continue ;;
		esac
		if [ -n "$header" ]; then
			say "$header"
			header=
		fi
		say "note:   $line"
	done <<EOF
$report
EOF
}

# read_sleep_disabled: SD=0|1 from `pmset -g`, empty when unreadable (the
# same parser as failsafe.sh).
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

# is_uint VALUE: VALUE is a non-empty string of decimal digits.
is_uint() {
	case $1 in
	'' | *[!0-9]*) return 1 ;;
	esac
	return 0
}

# released_since_armed: the same rule as failsafe.sh step 4. RELEASED is a
# regular file, not a symlink, whose mtime is at least the mtime of `armed`.
released_since_armed() {
	if [ -L "$RELEASED" ] || [ ! -f "$RELEASED" ]; then
		return 1
	fi
	r=$(/usr/bin/stat -f %m "$RELEASED" 2>/dev/null) || return 1
	is_uint "$r" || return 1
	a=$(/usr/bin/stat -f %m "$STATE/armed" 2>/dev/null) || return 1
	is_uint "$a" || return 1
	[ "$r" -ge "$a" ]
}

MY_UID=$(/usr/bin/id -u) || MY_UID=
case $MY_UID in
'' | *[!0-9]*) fail 1 'cannot read the user id' ;;
esac
[ "$MY_UID" -ne 0 ] || fail 1 'run this as your own user, not as root; it calls sudo itself'
ME=$(/usr/bin/id -un) || ME=
valid_user "$ME" || fail 1 "user name not allowed in a sudoers rule: $ME"
HOME_DIR=${HOME-}
valid_home "$HOME_DIR" || fail 1 "HOME must be /Users/<name>: $HOME_DIR"
if [ -L "$HOME_DIR" ] || [ ! -d "$HOME_DIR" ]; then
	fail 1 "HOME is not a directory: $HOME_DIR"
fi
OWNER=$(/usr/bin/stat -f %u "$HOME_DIR") || OWNER=
[ "$OWNER" = "$MY_UID" ] || fail 1 "HOME is not owned by $ME: $HOME_DIR"
CLAIM=$HOME_DIR/.herdr/herdr-caffeinate/claim
RELEASED=$HOME_DIR/.herdr/herdr-caffeinate/released

say 'herdr-caffeinate: removing closed-lid support and the fail-safe'
say 'sudo may ask for your admin password.'
PARTIAL=0
RESTORE_FAILED=0

# 1. Turn disablesleep off when closed-lid may be on. This reads the claim
# and `released` before step 4 removes them.
MAY_BE_ON=0
if [ -e "$CLAIM" ] || [ -L "$CLAIM" ]; then
	MAY_BE_ON=1
elif [ -e "$STATE/armed" ] && ! released_since_armed; then
	MAY_BE_ON=1
fi
if [ "$MAY_BE_ON" -eq 1 ]; then
	read_sleep_disabled
	if [ "$SD" != 0 ]; then
		if /usr/bin/sudo /usr/bin/pmset -a disablesleep 0; then
			say 'restored: disablesleep 0'
		else
			warn 'could not restore disablesleep 0'
			RESTORE_FAILED=1
			PARTIAL=1
		fi
	fi
fi

# 2-3. Stop the daemon and remove every root path, in the C8 order.
/usr/bin/sudo /bin/launchctl bootout "system/$LABEL" >/dev/null 2>&1 || :
/usr/bin/sudo /bin/rm -f "$PLIST" || PARTIAL=1
/usr/bin/sudo /bin/rm -f "$HELPER" || PARTIAL=1
/usr/bin/sudo /bin/rm -rf "$STATE" || PARTIAL=1
/usr/bin/sudo /bin/rm -f "$SUDOERS" "$SUDOERS.new" || PARTIAL=1

# 4. The claim and `released`, as yourself. A symlink is removed itself,
# never its target; anything else at those paths (a directory) is not ours
# to the watchdog and is left alone.
for p in "$CLAIM" "$RELEASED"; do
	if [ -L "$p" ] || [ -f "$p" ]; then
		/bin/rm -f "$p" || PARTIAL=1
	fi
done

# 5. Check what is left, our sudoers file, the claim and `released` included;
# `launchctl print` needs no privilege.
if /bin/launchctl print "system/$LABEL" >/dev/null 2>&1; then
	warn "the daemon system/$LABEL is still loaded"
	PARTIAL=1
fi
for p in "$PLIST" "$HELPER" "$STATE" "$SUDOERS" "$SUDOERS.new"; do
	if [ -e "$p" ] || [ -L "$p" ]; then
		warn "still present: $p"
		PARTIAL=1
	fi
done
for p in "$CLAIM" "$RELEASED"; do
	if [ -L "$p" ] || [ -f "$p" ]; then
		warn "still present: $p"
		PARTIAL=1
	fi
done
visudo_notes 'note: sudo visudo -c, which checks every sudoers file, reports the lines below about files herdr-caffeinate does not manage:'

read_sleep_disabled
if [ "$SD" = 1 ] && [ "$RESTORE_FAILED" -eq 0 ]; then
	say 'note: SleepDisabled is still 1, set by another tool, not by herdr-caffeinate.'
	say '      To clear it: sudo pmset -a disablesleep 0'
fi

if [ "$PARTIAL" -ne 0 ]; then
	warn 'some parts were not removed or restored; see the messages above'
	exit 40
fi
say 'uninstalled'
exit 0
