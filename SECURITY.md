# Security policy

## Supported versions

Security fixes go into the latest minor release only. Today that is **0.1.x**.

## Reporting a vulnerability

Report it privately to the maintainer, Lapis0875: through GitHub's private vulnerability reporting on the repository's
page (**Security → Report a vulnerability**) once it is published, or directly to @Lapis0875 on GitHub. Please do not
open a public issue, pull request or discussion for it.

Useful in a report:

- the herdr-caffeinate version or commit, `sw_vers`, and `herdr-app --version`;
- what an attacker needs (a process running as you, another local account, an admin password, …);
- steps or a proof of concept, and what happened against what you expected;
- `ls -l /etc/sudoers.d/ /Library/PrivilegedHelperTools/ /Library/LaunchDaemons/ /var/db/herdr-caffeinate/` and
  `cat /var/db/herdr-caffeinate/last-restore`, if it concerns the closed-lid helper.

## Threat model

herdr-caffeinate is a Herdr mod. Plain keep-awake (`/usr/bin/caffeinate`) needs no privilege. Closed-lid changes the
system setting `pmset -a disablesleep`, which needs root, so a one-time installer adds two privileged pieces: a sudoers
rule and a root fail-safe. This section describes what each piece can do and to whom.

| Piece | Runs as | Can do |
|---|---|---|
| The mod (`sys/`, `bin/probe.sh`) | you, inside Herdr | start and stop this Herdr's `caffeinate` holder; write and remove its claim and `released` files; run the two `sudo -n` commands below; run `pmset sleepnow` |
| The sudoers rule `/etc/sudoers.d/herdr-caffeinate` | root, through `sudo -n`, for your user only | `/usr/bin/pmset -a disablesleep 0` and `/usr/bin/pmset -a disablesleep 1`, nothing else |
| The fail-safe `/Library/PrivilegedHelperTools/io.github.lapis0875.herdr-caffeinate.failsafe` | root, started by launchd every 15 s | `pmset -a disablesleep 0`, `pmset sleepnow`, files under `/var/db/herdr-caffeinate/` |
| `bin/install.sh`, `bin/uninstall.sh` | you, with `sudo` and your admin password | create or remove the four root paths above and `/Library/LaunchDaemons/io.github.lapis0875.herdr-caffeinate.failsafe.plist`; the uninstaller also removes your `~/.herdr/herdr-caffeinate/claim` and `released` (as you, no `sudo`) |

### The sudoers rule

The installed file holds exactly one line, with your user name in place of `<you>`:

```
<you> ALL = (root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1
```

- **Exact arguments.** sudo matches a command with arguments exactly, so the rule allows these two command lines and
  nothing else: no other `pmset` argument, no other program, no shell, no other target user than root.
- **One user.** The user name is written only after it matches `^[a-z_][a-z0-9_-]*$`; anything else is refused before
  the first `sudo`. The rule names that user, not a group.
- **Checked before and after, installed atomically.** The rendered file passes `visudo -cf` before it is installed; it
  is installed as root:wheel 0440 under a name with a dot (`herdr-caffeinate.new`, which sudo skips in `sudoers.d`)
  and then renamed. Afterwards the installer verifies only what it installed: `sudo visudo -cf
  /etc/sudoers.d/herdr-caffeinate` and `sudo -n -l /usr/bin/pmset -a disablesleep 0` and `… 1`; a failure removes our
  file again (exit 10). A whole-config `sudo visudo -c` runs only to print what it reports about other files as notes,
  because another app's file can fail it while sudo still reads that file (see Amphetamine below); it never fails the
  install or the uninstall, and it never touches another app's file.
- **No prompts.** The mod runs only `sudo -n` (non-interactive). A refusal means the rule is missing; the mod then shows
  closed-lid as Unavailable and never asks for a password.

**Residual risk: any process running as you.** The rule is for your user, not for Herdr, so every process running as
you can run these two commands without a password. What it gains:

- keep the Mac awake with the lid closed (`disablesleep 1`), which can mean heat and battery drain in a bag;
- turn another tool's `disablesleep 1` off (`disablesleep 0`).

It gains nothing else: no root shell, no file access as root, no other `pmset` setting. The fail-safe does not undo a
`disablesleep 1` it did not arm (that is how another tool's setting is left alone), so a process that sets 1 without a
claim keeps the Mac from sleeping on a closed lid until someone sets it back. The menu then shows closed-lid as "Set by
another app", and `pmset -g | grep SleepDisabled` shows `1`. A process running as you can already do much more harm
than this, including running `caffeinate` itself to stop idle sleep; the capability the rule adds is sleep prevention
with the lid closed. Uninstalling removes the rule.

**Context: Amphetamine.** Amphetamine's Power Protect installs a broader rule for the same two commands. On the Mac
this mod was built on, `/private/etc/sudoers.d/amphetamine_PowerProtect` reads:

```
Cmnd_Alias PMSET_AMPHETAMINE= /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0
%admin ALL=(ALL) NOPASSWD: PMSET_AMPHETAMINE
```

That grants both commands to every admin user, as any target user. That file's mode there is 0644, so a whole-config
`sudo visudo -c` fails with `/private/etc/sudoers.d/amphetamine_PowerProtect: bad permissions, should be mode 0440`
while sudo still reads the file; this is why the installer checks only its own file and the rule, and prints that
line as a note. Where it exists, our rule gives an admin user nothing new (and `sudo -n -l` succeeds through either
rule); it is narrower (one user, root only) and is installed anyway, so herdr-caffeinate does not depend on another
app's rule: removing Amphetamine leaves ours, and our uninstaller leaves Amphetamine's.

### The root fail-safe

launchd runs `/bin/sh /Library/PrivilegedHelperTools/io.github.lapis0875.herdr-caffeinate.failsafe
/Users/<you>/.herdr/herdr-caffeinate/claim` as root at load and every 15 s (`StartInterval` 15, `RunAtLoad`, no
`KeepAlive`, no `WatchPaths`).

- **A root-owned copy.** It runs the copy in `/Library/PrivilegedHelperTools/` (root:wheel 0755), not
  `bin/failsafe.sh` in the mod folder, which you and any process running as you can edit. Editing the mod changes
  nothing at root until you reinstall with your password.
- **One validated path.** The argument is fixed in the root-owned plist, and the script still rejects anything but
  `/Users/<name>/.herdr/herdr-caffeinate/claim`, where `<name>` is one path segment of `[A-Za-z0-9._-]` that does not
  start with a dot and holds no `..`. A rejected argument exits 64 with nothing read or written.
- **Only modification times.** From your home it reads only the modification times of the claim and of
  `~/.herdr/herdr-caffeinate/released` (derived from the validated claim path, never from other input), with
  `stat -f %m` (no `-L`), and only when each path is a regular file and not a symlink. A swap between that test and the
  `stat` makes it read the link's own time, which is harmless. It never reads their content, and never creates, writes
  or removes anything in your home.
- **Writes in one place.** It writes only under `/var/db/herdr-caffeinate/`: `alive`, `armed`, `handled` and
  `last-restore` (root, folder 0755, files 0644: readable by everyone, writable by root only).
- **Fixed environment.** `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LC_ALL=C`, `set -u`, every tool by absolute path, no
  `eval` or `source`; numbers are checked to be digits before any arithmetic.
- **It can only turn sleep back on.** Its only state changes are `pmset -a disablesleep 0` and `pmset sleepnow`. The
  first runs only when `SleepDisabled` reads 1 and there is a claim to answer for: a claim older than 45 s (once per
  claim time, and not in the first 60 s after a wake), a claim gone while it is armed and not released by the mod (no
  `released` at least as new as `armed`), or the battery below 10 % while it is armed. With no claim and nothing armed,
  or with no claim after the mod's own release, it changes nothing (it only removes `armed`). `sleepnow` runs after a
  restore only when the lid is closed and macOS would sleep on a closed lid. It never sets `disablesleep 1`.
- **Fails safe.** If `SleepDisabled` cannot be read, it changes nothing and keeps its state, and the next run (15 s
  later) tries again. A claim dated in the future counts as stale. A missing or malformed wake time grants no wake
  grace.

What a process running as you can do through the claim and `released`, which are your files:

- keep the claim fresh: the fail-safe does not restore, the same outcome as running `sudo -n pmset -a disablesleep 1`
  itself;
- remove the claim (without touching `released`), or let it go stale, while the fail-safe is armed: the fail-safe turns
  sleep back on, which is the safe direction;
- touch `released` while the fail-safe is armed, then remove the claim: the fail-safe only disarms and leaves
  `disablesleep 1` on, the same outcome as running `sudo -n pmset -a disablesleep 1` itself;
- create the claim while another tool holds `disablesleep 1`: the fail-safe arms and later sets 0, turning the other tool's
  setting off, the same outcome as running `sudo -n pmset -a disablesleep 0`, which the rule already allows.

### The installer and uninstaller

- They run as you and call `sudo` for each privileged step; they refuse to run as root (uid 0).
- Before the first `sudo` they check the user name (the sudoers rule above) and the home (`/Users/<name>`, a directory,
  not a symlink, owned by you).
- Every root file is installed with `install -o root -g wheel -m <mode>`; the helper with `-S`, so a running fail-safe
  keeps reading the old copy until the new one is renamed into place; the plist passes `plutil -lint` first.
- They copy from the mod folder they run from. Whoever can edit `mods/herdr-caffeinate/bin/` before you type your
  admin password decides what root will run, as with any script you run with `sudo`. Install from a copy you trust,
  and read `bin/failsafe.sh`, `bin/sudoers.tmpl` and `bin/failsafe.plist.tmpl` first if in doubt.
- macOS shows a "Background Items Added" notice when the daemon loads. That notice is expected; the item it names is
  this daemon.

### The mod

- It runs with your rights inside Herdr, which treats mods as trusted code.
- It stops a process only after `ps -o command=` shows exactly a holder command line of this Herdr
  (`/usr/bin/caffeinate -i -s [-d] -w <Herdr pid> [-t <n>]`, or the same behind `nohup` right after launch).
- It writes the claim with `umask 077` in a 0700 folder, through a temporary file and a rename, which replaces a
  symlink instead of following it. Before each new claim it removes `released` with `/bin/rm -f` (a symlink itself,
  never its target), so a `released` never outlives the next engage; if that removal fails, it engages nothing and
  closed-lid shows Unavailable. It touches `released` (`umask 077`) only after its own `disablesleep 0` reads back 0,
  just before it removes the claim.
- Every `disablesleep` change is read back. A change that does not take is undone, and closed-lid shows Unavailable.
- It makes no network connections.

### Out of scope

- Someone who already has your admin password, root, or your unlocked Mac.
- A malicious mod or program already running as you: beyond the two `pmset` commands above, it can do whatever you
  can, with or without herdr-caffeinate.
- Bugs in macOS's `pmset`, `launchd` or `sudo` (report those to Apple). `disablesleep` is undocumented and may change
  in a macOS update; the mod reads every change back and reports Unavailable when it stops working.
