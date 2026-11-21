# herdr-caffeinate acceptance

The 22 acceptance scenarios (AT-01 to AT-22) for the requirements A1 to A16, and what the four spikes found. Run them on
the installed copy in `~/.config/herdr-app/mods/herdr-caffeinate`, in the owner's running Herdr window. Scenarios
marked **owner** need the owner at the keyboard: typing the admin password, killing or stopping Herdr, closing the lid.
The tester runs the checks and records the evidence.

## Conventions

- **Read C3:** `jq . ~/.config/herdr-app/data/herdr-caffeinate/state.json` (the last published shared state).
- **Set `x=v`:** edit `~/.config/herdr-app/data/herdr-caffeinate/settings.json` (fields of C2, and `fake.*` only with
  `debug: true`), for example `f=~/.config/herdr-app/data/herdr-caffeinate/settings.json; jq '.debug=true |
  .fake.percent=19' "$f" > /tmp/hc-s.json && mv /tmp/hc-s.json "$f"`, then run `herdr-app do herdr-caffeinate.refresh`
  and wait 12 s.
- **Holder checks** count only this Herdr's holder, the one with `-w <Herdr pid>`:
  `pgrep -lf "^/usr/bin/caffeinate -i -s.* -w $(pgrep -x Herdr)( |$)"`. Other apps run their own (Orca runs
  `caffeinate -i -s -w <Orca pid>`); ignore them. For AT-05, use the pid noted before the kill.
- **Commands** (`herdr-app do herdr-caffeinate.*`) need a shown copy. In the lazuli layout the host is open from
  services start; elsewhere run `herdr-app do mod.open '{"name":"herdr-caffeinate"}'` first. Success is exit 0 with no
  `error` key.
- **Order** (G1): AT-16, AT-11, AT-19, AT-22, AT-01 to AT-04, AT-18, AT-13, AT-20 (not installed), AT-06 (install and
  uninstall), install again, AT-07 to AT-10, AT-12, AT-17, AT-14, AT-15, AT-05, AT-21.

| Requirement | Scenarios |
|---|---|
| A1 caffeinate holder | AT-01, AT-17 |
| A2 display | AT-02 |
| A3 Agent mode | AT-03 |
| A4 Timer | AT-04, AT-18 |
| A5 holder dies with Herdr | AT-05 |
| A6 install and uninstall | AT-06, AT-19 |
| A7 closed-lid engage | AT-07, AT-20 |
| A8 fail-safe | AT-08 |
| A9 foreign `disablesleep` | AT-09 |
| A10 safety blocks | AT-10, AT-21 |
| A11 root battery floor, no clobber | AT-11 |
| A12 AC trigger | AT-12 |
| A13 chip, menu, commands, languages | AT-13 |
| A14 lazuli | AT-14, AT-15 |
| A15 tests and checks | AT-16 |
| A16 documentation | AT-22 |

## Automated

### AT-16 Test suites and checks (A15)

In this repository `npm test` and `herdr-app check mods/herdr-caffeinate`; in the lazuli repository `npm test` and
`herdr-app check mods/lazuli`. Expected: all pass with 0 failures, the purity test included. Evidence: the summary
lines.

### AT-11 Root battery floor and no clobber (A11)

`node --test tests/failsafe.test.mjs` (fake `pmset`, `ioreg`, `sysctl`). Expected: a fresh claim writes nothing; a
stale claim writes one `disablesleep 0` and a second run writes nothing; no claim and no `armed` with `SleepDisabled 1`
writes nothing; no claim with `armed` restores, unless `released` is a regular file at least as new as `armed` (then
`armed` is removed and nothing is written even with `SleepDisabled 1`, the AT-09 race); an older or symlinked
`released` still restores; a new arm after a release refreshes `armed`; a symlinked claim is ignored; with the lid shut
`sleepnow` follows the restore; the wake grace holds; the battery floor acts only when `armed` and below 10 %; a bad
`$1` does nothing; the shipped file uses only absolute tool paths.

### AT-19 Installer refuses bad input (A6)

`node --test tests/install.test.mjs`. Expected: the rendered sudoers equals the C6 line byte for byte and passes
`visudo -cf`; hostile user names (`a b`, `root;`, `../x`) are refused before anything is written; the rendered plist
passes `plutil -lint`; uid 0 is refused. The same file runs `install.sh` and `uninstall.sh` from sandboxed copies with
fake `sudo`, `visudo`, `launchctl` and `install`: after installing, our file is verified alone (`sudo visudo -cf`)
and with `sudo -n -l /usr/bin/pmset -a disablesleep 0` and `… 1`; a foreign file that fails the whole-config
`visudo -c` (Amphetamine's `amphetamine_PowerProtect: bad permissions, should be mode 0440`) is printed as a `note:`
line and fails neither the install nor the uninstall; our file failing `visudo -cf`, or `sudo -n -l` refusing either
command, exits 10 and removes only our file; the uninstaller exits 40 when the daemon or our sudoers file is left or the
claim or `released` cannot be removed; uninstall removes the claim and `released` (a symlink itself, not its target),
so a reinstalled watchdog never turns off a foreign `disablesleep 1`; it restores 0 for a claim, or for `armed` without
a `released` at least as new, and leaves a foreign 1 alone after our release.

### AT-22 Documentation lists programs and privilege (A16)

`grep -n -E 'caffeinate|pmset|sudo -n|ioreg|osascript|launchctl' README.md README.ko.md`, then read the Install,
Uninstall and Security sections of both. Expected: each program is named in both files; the C6 sudoers line, the C4
paths and the uninstall steps appear in both.

## Keep-awake

### AT-01 Mode On holds one caffeinate process (A1)

On AC, mode Off, display off. `herdr-app do herdr-caffeinate.mode:on`, wait 3 s, check the holder and
`pmset -g assertions | grep -A2 caffeinate`; then `mode:off`, wait 3 s, check again. Expected: after On exactly one
holder whose argv starts with `/usr/bin/caffeinate -i -s` and contains `-w <Herdr pid>`, with `PreventUserIdleSystemSleep`
and `PreventSystemSleep`; after Off none; C3 `active` true, then false.

### AT-02 Display toggle adds -d (A2)

Mode On. `display:on`, wait 3 s, `pgrep -lf caffeinate` and `pmset -g assertions | grep -B1 -A3 caffeinate`;
`display:off`, wait 3 s, check again. Expected: with display on one holder with `-d` and `PreventUserIdleDisplaySleep`;
with display off one holder without `-d`; never two holders after the wait.

### AT-03 Agent mode follows working agents (A3)

Mode Agent, `lingerSec` 30, an idle `omp` or `claude` in a local tab. Prompt it to work at least 60 s ("count slowly to
60 using a shell sleep loop"); check the holder after 10 s; once `herdr-app ls` shows it `done` or `idle`, check at
+10 s and +40 s. Expected: holder while working, still at +10 s, gone at +40 s.

### AT-04 Timer runs and ends (A4)

Mode Off. `timer:2`, then `herdr-app do herdr-caffeinate.menu` and `herdr-app shot /tmp/hc-timer.png`; check the holder
at +30 s and +130 s; read C3. Expected: the menu shows between 1:00 and 2:00 left; holder at +30 s; at +130 s no holder
and `mode` `off`.

### AT-18 Timer bounds (A4)

Mode Off. `timer:0`, `timer:1441`, `timer:abc`, then `timer:1440` and `timer:cancel`. Expected: the first three change
nothing (one log line each); 1440 starts a session with `endsAt` 24 h ahead; cancel ends it.

### AT-05 Holder dies with Herdr (A5) — owner

Mode On with a holder. Note `pgrep -x Herdr`; the **owner** runs `kill -9 <pid>`; after 5 s check for the holder; the
owner restarts Herdr. Expected: no holder 5 s after the kill; after the restart, with `mode: on`, a new holder.

### AT-17 Mode and settings persist across reload (A1)

Mode On, display on, closed-lid on (installed). Save `main.js` unchanged (or switch layout and back); after 15 s
`pgrep -lf caffeinate`, `pmset -g | grep SleepDisabled`, read `settings.json`. Expected: one holder (the same pid, or
replaced once, never two), `SleepDisabled 1` still held, settings unchanged.

## UI

### AT-13 Chip, menu, commands and languages (A13)

A test layout with a 40 px block `{ "mod": "herdr-caffeinate" }`, system language Korean. Shoot the chip; click it (or
`menu`) and shoot the menu; run every C1 command except `install` and `uninstall` once (`display:*` and `closed-lid:*`
while mode On); set `language` to `"en"` and shoot again; run `timer:0`. Expected: the menu shows mode, timer presets
and minutes, time left, display, closed-lid with install state and block reason, AC-only, battery floor, AC trigger,
Install and Uninstall; every command exits 0 without `error`; every command other than `menu` and `refresh` changes C3
as named; `timer:0` changes nothing; the texts switch language.

### AT-14 lazuli shows the chip when installed (A14)

lazuli layout, mod installed. Shoot the status bar; click the chip; `mode:on` and shoot again; search "caffeinate" in
lazuli's palette. Expected: the chip with mode Off, then active styling; the click opens this mod's menu; the palette
lists the caffeinate entries.

### AT-15 lazuli without the mod (A14)

Move `~/.config/herdr-app/mods/herdr-caffeinate` aside, restart Herdr in lazuli. Shoot the status bar; search
"caffeinate" in the palette; with lazuli `debug: true`, `grep -i caffeinate ~/.config/herdr-app/data/lazuli/debug.log`;
put the folder back. Expected: no chip, no palette entries, no caffeinate log lines, and the status bar otherwise as
before.

## Closed-lid

### AT-20 Closed-lid without install is unavailable (A7)

Not installed (or the daemon booted out). `closed-lid:on`; after 2 s `pmset -g | grep SleepDisabled` and C3; shoot the
menu. Expected: `SleepDisabled` still 0, C3 `closedLid.status` `unavailable`, the menu offers Install.

### AT-06 Install and uninstall (A6) — owner

No `/etc/sudoers.d/herdr-caffeinate`. `herdr-app do herdr-caffeinate.install`; the **owner** types the admin password
in the tab and reports its last lines. Then `sudo cat /etc/sudoers.d/herdr-caffeinate`,
`sudo visudo -cf /etc/sudoers.d/herdr-caffeinate`, `sudo -n -l /usr/bin/pmset -a disablesleep 0; echo $?`,
`sudo -n -l /usr/bin/pmset -a disablesleep 1; echo $?`, `stat -f '%Su:%Sg %Lp' /etc/sudoers.d/herdr-caffeinate`,
`launchctl print system/io.github.lapis0875.herdr-caffeinate.failsafe | head -5` (works without sudo), and
`stat -f %m /var/db/herdr-caffeinate/alive` twice 20 s apart; then `herdr-app do herdr-caffeinate.uninstall` (**owner**
password if asked) and list every C4 root path. Expected: the installer exits 0 (other files' findings from the
whole-config `sudo visudo -c` may appear as `note:` lines, such as Amphetamine's 0644 `amphetamine_PowerProtect`); the
file is the C6 line with the owner's user name, `root:wheel 440`, `visudo -cf` on it OK, both `sudo -n -l` exit 0; the
daemon is loaded; `alive` advances; after uninstall every C4 root path is gone and `SleepDisabled` is 0.

Then install again (**owner** password) for the scenarios below.

### AT-07 Closed-lid engages and disengages (A7)

Installed, on AC, mode On, closed-lid off. `closed-lid:on`; after 2 s `pmset -g | grep SleepDisabled` and
`ls -l ~/.herdr/herdr-caffeinate/claim`; `closed-lid:off`; after 2 s check again; repeat with `mode:off` as the way
out. Expected: `SleepDisabled 1` and a claim after on; `SleepDisabled 0` and no claim after off and after mode Off; C3
`closedLid.status` `engaged`, then `off`.

### AT-08 Fail-safe after kill and hang (A8) — owner

The AT-07 engaged state. The **owner** runs `kill -9 $(pgrep -x Herdr)`; poll `pmset -g | grep SleepDisabled` every 5 s
for 90 s; the owner restarts Herdr and re-engages, then runs `kill -STOP $(pgrep -x Herdr)`; poll for 90 s; then
`kill -CONT`; `cat /var/db/herdr-caffeinate/last-restore`. Expected: 0 within 75 s after the kill and after the STOP;
`last-restore` names `stale-claim`; the terminals survive in herdr-core. (The keeper fallback's 10 min window does not
apply: S3 chose engine timers.)

### AT-09 Foreign disablesleep is left alone (A9)

Installed, closed-lid off, no claim. `sudo pmset -a disablesleep 1`; wait 120 s; `pmset -g | grep SleepDisabled`;
`menu`, wait 3 s, `herdr-app shot`, read C3; `ls /var/db/herdr-caffeinate/`; then `sudo pmset -a disablesleep 0`.
Expected: still 1 after 120 s; menu and C3 show `external`; no `armed` file; `last-restore` unchanged.

### AT-10 Safety blocks and sleep on disengage (A10)

Installed, mode On, closed-lid on, `debug: true`. (a) `fake.ac=false` with `acOnly` true; (b) `acOnly` false,
`fake.ac=false`, `fake.percent=19` with floor 20; (c) `fake.percent=24`, then `25`; (d) `fake.percent=80`,
`fake.thermal=2`, then `fake.thermal=1` twice. After each step `pmset -g | grep SleepDisabled` and C3. Then
`node --test --test-name-pattern sleepNow tests/`. Expected: (a) `blocked` `ac`, 0; (b) `blocked` `battery`, 0; (c) at
24 still `battery`, at 25 `engaged` and 1; (d) `thermal` at 2, `engaged` again at the latest after the second
`fake.thermal=1`; the named tests show `sleepNow` only when the lid is closed and causes sleep.

### AT-12 AC trigger (A12)

Mode Off, `trigger.ac.enabled true`, `debug: true`. `fake.ac=false` → tick → `fake.ac=true` → tick → C3;
`fake.ac=false` → tick → C3; `fake.ac=true` → tick; `mode:off` with `fake.ac` still true → two ticks → C3;
`fake.ac=false` then `true` → tick → C3. Plus the reducer tests for the edge, the suppression and trigger-only end.
Expected: an `origin: trigger` session starts on the plug edge and ends on unplug; after a user Off on AC no new
session until the next unplug and plug.

### AT-21 Physical lid run (A10) — owner

Installed, on AC, **no external display** attached (S3: `AppleClamshellCausesSleep` can stay a stale No after one is
unplugged), mode On, closed-lid on. In a terminal run `while :; do date +%s >> /tmp/hc-lid.log; sleep 5; done`; the
**owner** closes the lid for 3 min and opens it; check the log for gaps over 10 s. Then start
`(sleep 60; f=~/.config/herdr-app/data/herdr-caffeinate/settings.json; jq '.debug=true | .fake.ac=false |
.fake.percent=5 | .closedLid.acOnly=false' "$f" > /tmp/hc-s.json && mv /tmp/hc-s.json "$f") &`; the owner closes the
lid at once for 3 min and opens it; check the log for a gap that starts 60 to 80 s after closing; read C3; remove
`fake` and set `debug` false. Expected: the first run has no gap; the second has a gap starting 60 to 80 s after
closing (the Mac slept through `sleepnow`) and C3 shows `blocked` `battery`.

## Spikes

Four spikes settled what the contracts could not assume. Full records with commands and outputs are in
[docs/spikes/](spikes/).

| Spike | Question | Finding |
|---|---|---|
| [S1](spikes/S1.md) | Can a mod start a `caffeinate` that outlives its `exec`? | Yes. `$PPID` inside `exec("/bin/sh", …)` is Herdr's pid. `nohup "$@" >/dev/null 2>&1 & echo "$!"` survives the `exec` returning, four mod reloads, an overlay close and an `exec` timeout; `pmset -g assertions` lists it on Herdr's behalf; `-w` releases at once when its target exits. Right after launch `ps` may still show `nohup <argv>`. No `-t` lease fallback is needed. |
| [S2](spikes/S2.md) | Can lazuli host this mod in a hidden window? | Yes: a frameless 2 × 2 `kind: "window"` overlay stays open, is invisible in shots and receives `herdr-app do` commands through `nextCommand()`. Every shown copy receives each command. `{owner: null}` timers stop when the copy that started them closes, so the engine must live in a shown copy and restart from its files; the shared-mailbox fallback was rejected. A mod folder whose `main.js` appears before `mod.json` gets docked into the shown layout. |
| [S3](spikes/S3.md) | Do Herdr's timers keep running with the lid closed? | Yes: over a 49.5-minute lid-closed run on AC, the largest gap of a 10 s `{owner: null}` timer was 10.199 s, so the engine's own ticks keep the claim fresh and the keeper fallback (C11a) is not used. With an external display, `AppleClamshellCausesSleep` read No with the lid closed and stayed No after the display was unplugged, so AT-21 runs without one. |
| [S4](spikes/S4.md) | Which readers work, unprivileged? | `ioreg -r -k AppleClamshellState -d 1` gives both clamshell keys; `sysctl -n kern.waketime` has a fixed `{ sec = …, usec = … }` format (the 60 s wake grace stays); `launchctl print system/<label>` works without sudo (exit 113 when missing); `osascript` `thermalState` reads 0 idle and under 20 s of full load (so AT-10 uses `fake.thermal`). A full probe costs about 90 ms. |
