#!/bin/sh
# herdr-caffeinate uninstaller (docs/CONTRACTS.md C8).
#
# Run as yourself, not as root (Herdr runs it in a tab); it calls sudo for
# each privileged step:
#   /bin/sh uninstall.sh
# 1. When Herdr's claim (~/.herdr/herdr-caffeinate/claim) or the watchdog's
#    `armed` file exists, closed-lid may be on: restore
#    `pmset -a disablesleep 0` unless SleepDisabled already reads 0.
# 2. Stop the daemon (`launchctl bootout`).
# 3. Remove the plist, the helper, /var/db/herdr-caffeinate and the sudoers
#    file, then check that each is gone and the daemon is not loaded.
#    A whole-config `sudo visudo -c` runs only to print other files'
#    findings as notes (Amphetamine's 0644 amphetamine_PowerProtect fails
#    it while sudo still reads it); it never changes the exit code.
# 4. Say so when SleepDisabled is still 1, set by another tool.
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

say 'herdr-caffeinate: removing closed-lid support and the fail-safe'
say 'sudo may ask for your admin password.'
PARTIAL=0
RESTORE_FAILED=0

# 1. Turn disablesleep off when closed-lid may be on.
if [ -e "$CLAIM" ] || [ -L "$CLAIM" ] || [ -e "$STATE/armed" ]; then
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

# Check what is left, our sudoers file included; `launchctl print` needs no
# privilege.
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
