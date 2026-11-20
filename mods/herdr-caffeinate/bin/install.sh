#!/bin/sh
# herdr-caffeinate installer (docs/CONTRACTS.md C8).
#
# Run as yourself, not as root (Herdr runs it in a tab); it calls sudo for
# each privileged step, so sudo asks for the admin password once:
#   /bin/sh install.sh
# It installs:
#   /etc/sudoers.d/herdr-caffeinate (root:wheel 0440): the C6 rule from
#     sudoers.tmpl, allowing only `pmset -a disablesleep 0` and `… 1`
#   /Library/PrivilegedHelperTools/io.github.lapis0875.herdr-caffeinate.failsafe
#     (root:wheel 0755): a copy of failsafe.sh
#   /var/db/herdr-caffeinate/ (root:wheel 0755): the watchdog's state
#   /Library/LaunchDaemons/io.github.lapis0875.herdr-caffeinate.failsafe.plist
#     (root:wheel 0644): the C7 daemon from failsafe.plist.tmpl
# then starts the daemon and waits until it reports `alive`.
#
# The sudoers step checks only what it installed: `sudo visudo -cf` on our
# file and `sudo -n -l` for both pmset commands. A whole-config
# `sudo visudo -c` runs afterwards only to print other files' findings as
# notes; another app's file can fail it while sudo still reads that file
# (Amphetamine installs amphetamine_PowerProtect with mode 0644).
#
# Rendering only, without privilege (tests/install.test.mjs):
#   install.sh --render-sudoers <user>   prints the C6 sudoers file
#   install.sh --render-plist <home>     prints the C7 LaunchDaemon plist
#
# Exit: 0 installed; 1 refused (root, invalid user or home, missing file);
# 2 usage or invalid render argument; 10 sudoers step (our file is removed
# again); 20 helper or state directory step; 30 plist or daemon step.

set -u
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
LC_ALL=C
export LC_ALL

LABEL=io.github.lapis0875.herdr-caffeinate.failsafe
SUDOERS=/etc/sudoers.d/herdr-caffeinate
HELPER_DIR=/Library/PrivilegedHelperTools
HELPER=$HELPER_DIR/$LABEL
PLIST=/Library/LaunchDaemons/$LABEL.plist
STATE=/var/db/herdr-caffeinate
BOOTSTRAP_TRIES=3
ALIVE_WAIT=30

case $0 in
*/*) HERE=${0%/*} ;;
*) HERE=. ;;
esac

say() {
	printf '%s\n' "$*"
}

# fail CODE MESSAGE: print to stderr and exit with CODE.
fail() {
	code=$1
	shift
	printf 'herdr-caffeinate install: %s\n' "$*" >&2
	if [ "$code" -ge 20 ]; then
		printf 'herdr-caffeinate install: run %s/uninstall.sh to remove what was installed.\n' "$HERE" >&2
	fi
	exit "$code"
}

# valid_user NAME: the C6 rule ^[a-z_][a-z0-9_-]*$.
valid_user() {
	case $1 in
	'' | [!a-z_]* | *[!a-z0-9_-]*) return 1 ;;
	esac
	return 0
}

# valid_home PATH: /Users/<name>, <name> one segment of [A-Za-z0-9._-] not
# starting with a dot. failsafe.sh accepts the claim path under exactly these.
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

# The arguments are validated first, so they hold no sed metacharacters.
render_sudoers() {
	/usr/bin/sed "s/__USER__/$1/g" "$HERE/sudoers.tmpl"
}

render_plist() {
	/usr/bin/sed "s|__HOME__|$1|g" "$HERE/failsafe.plist.tmpl"
}

# visudo_notes HEADER: run the whole-config `sudo -n visudo -c` for
# information only and print every line other than "<file>: parsed OK" as a
# note under HEADER. Its result never changes the exit code.
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

USAGE='usage: install.sh [--render-sudoers <user> | --render-plist <home>]'
case ${1-} in
--render-sudoers)
	[ "$#" -eq 2 ] || fail 2 "$USAGE"
	valid_user "$2" || fail 2 "invalid user name: $2"
	[ -f "$HERE/sudoers.tmpl" ] || fail 1 "missing $HERE/sudoers.tmpl"
	render_sudoers "$2"
	exit
	;;
--render-plist)
	[ "$#" -eq 2 ] || fail 2 "$USAGE"
	valid_home "$2" || fail 2 "invalid home: $2"
	[ -f "$HERE/failsafe.plist.tmpl" ] || fail 1 "missing $HERE/failsafe.plist.tmpl"
	render_plist "$2"
	exit
	;;
*)
	[ "$#" -eq 0 ] || fail 2 "$USAGE"
	;;
esac

# Who and where. Everything is checked before the first sudo call.
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
for f in sudoers.tmpl failsafe.sh failsafe.plist.tmpl; do
	[ -f "$HERE/$f" ] || fail 1 "missing $HERE/$f"
done

WORK=
cleanup() {
	if [ -n "$WORK" ]; then
		/bin/rm -rf "$WORK"
	fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
WORK=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/herdr-caffeinate.XXXXXX") || fail 1 'cannot create a temporary directory'

say "herdr-caffeinate: installing closed-lid support for $ME"
say "  $SUDOERS: lets $ME run /usr/bin/pmset -a disablesleep 0 or 1 without a password"
say "  $HELPER: root fail-safe that turns disablesleep back off when Herdr stops"
say "  $PLIST: runs the fail-safe every 15 s"
say "  $STATE/: fail-safe state"
say 'sudo asks for your admin password.'

# 1. sudoers rule. Staged under a name with a dot, which sudo skips in
# sudoers.d, then renamed, so sudo never reads a half-written file.
say '1/3 sudoers rule'
render_sudoers "$ME" >"$WORK/sudoers" || fail 10 'cannot render the sudoers rule'
/usr/sbin/visudo -cf "$WORK/sudoers" >/dev/null || fail 10 'the rendered sudoers rule does not parse'
if ! /usr/bin/sudo /usr/bin/install -o root -g wheel -m 0440 "$WORK/sudoers" "$SUDOERS.new"; then
	/usr/bin/sudo -n /bin/rm -f "$SUDOERS.new" 2>/dev/null
	fail 10 "cannot write $SUDOERS"
fi
if ! /usr/bin/sudo /bin/mv -f "$SUDOERS.new" "$SUDOERS"; then
	/usr/bin/sudo -n /bin/rm -f "$SUDOERS.new" 2>/dev/null
	fail 10 "cannot write $SUDOERS"
fi

# Verify our file alone and that sudo now grants both commands without a
# password; otherwise remove it again.
if ! /usr/bin/sudo /usr/sbin/visudo -cf "$SUDOERS" >/dev/null; then
	/usr/bin/sudo -n /bin/rm -f "$SUDOERS" 2>/dev/null
	fail 10 "visudo -cf $SUDOERS failed; removed $SUDOERS"
fi
for v in 0 1; do
	if ! /usr/bin/sudo -n -l /usr/bin/pmset -a disablesleep "$v" >/dev/null; then
		/usr/bin/sudo -n /bin/rm -f "$SUDOERS" 2>/dev/null
		fail 10 "sudo -n -l /usr/bin/pmset -a disablesleep $v was refused; removed $SUDOERS"
	fi
done
visudo_notes 'note: sudo visudo -c, which checks every sudoers file, reports the lines below about other files; herdr-caffeinate does not depend on them and its own rule passed:'

# 2. Helper (installed through a temporary file and a rename, so a running
# watchdog keeps reading the old copy) and state directory.
say '2/3 fail-safe helper'
if [ ! -d "$HELPER_DIR" ]; then
	/usr/bin/sudo /usr/bin/install -d -o root -g wheel -m 0755 "$HELPER_DIR" || fail 20 "cannot create $HELPER_DIR"
fi
/usr/bin/sudo /usr/bin/install -S -o root -g wheel -m 0755 "$HERE/failsafe.sh" "$HELPER" || fail 20 "cannot install $HELPER"
/usr/bin/sudo /usr/bin/install -d -o root -g wheel -m 0755 "$STATE" || fail 20 "cannot create $STATE"

# 3. LaunchDaemon. `enable` clears an earlier `launchctl disable`; a
# bootstrap right after a bootout can fail while the old job is still
# going away, so it gets a few tries.
say '3/3 LaunchDaemon'
render_plist "$HOME_DIR" >"$WORK/failsafe.plist" || fail 30 'cannot render the LaunchDaemon plist'
/usr/bin/plutil -lint "$WORK/failsafe.plist" >/dev/null || fail 30 'the rendered LaunchDaemon plist does not lint'
/usr/bin/sudo /usr/bin/install -o root -g wheel -m 0644 "$WORK/failsafe.plist" "$PLIST" || fail 30 "cannot install $PLIST"
/usr/bin/sudo /bin/launchctl bootout "system/$LABEL" >/dev/null 2>&1 || :
/usr/bin/sudo /bin/launchctl enable "system/$LABEL" || fail 30 "launchctl enable system/$LABEL failed"
START=$(/bin/date +%s)
tries=1
until /usr/bin/sudo /bin/launchctl bootstrap system "$PLIST"; do
	[ "$tries" -lt "$BOOTSTRAP_TRIES" ] || fail 30 "launchctl bootstrap system $PLIST failed"
	tries=$((tries + 1))
	/bin/sleep 1
done

# RunAtLoad runs the watchdog at once; `alive` touched since START proves it.
waited=0
while :; do
	m=$(/usr/bin/stat -f %m "$STATE/alive" 2>/dev/null) || m=
	case $m in
	'' | *[!0-9]*) ;;
	*) [ "$m" -ge "$START" ] && break ;;
	esac
	[ "$waited" -lt "$ALIVE_WAIT" ] || fail 30 "the fail-safe did not report alive within $ALIVE_WAIT s (launchctl print system/$LABEL)"
	waited=$((waited + 1))
	/bin/sleep 1
done

say "installed: sudoers rule for $ME and the fail-safe daemon $LABEL (alive)"
exit 0
