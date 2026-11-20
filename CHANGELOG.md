# Changelog

All notable changes to herdr-caffeinate are listed here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-20

The first version.

### Added

- Modes Off, On, Agent and Timer. While a mode keeps the Mac awake, one detached
  `/usr/bin/caffeinate -i -s -w <Herdr pid>` runs, adopted across mod reloads, killed only after its argv is checked,
  and ended by `-w` when Herdr exits. Agent mode follows local Herdr agents with status `working` and lingers 30 s;
  Timer takes 15 min, 1 h, 2 h or 1 to 1440 minutes and its holder carries `-t <seconds left>`. The mode persists
  across restarts.
- "Keep the display on" (`caffeinate -d`).
- Closed-lid mode through `pmset -a disablesleep 1/0`, run with `sudo -n` under a one-line, exact-argument sudoers
  rule, every change read back; status Off, On, Paused (with the reason), Unavailable or Set by another app, which is
  never overwritten.
- Closed-lid safety: power adapter only by default, a battery floor (default 20 %, 10 to 90, clears at floor + 5 %),
  a thermal block at serious or worse, a block after three unreadable power reads, one Herdr per user, and
  `pmset sleepnow` when closed-lid ends while the lid is shut.
- The root fail-safe: a LaunchDaemon (`io.github.lapis0875.herdr-caffeinate.failsafe`, every 15 s) that restores
  `disablesleep 0` when the claim heartbeat is older than 45 s, when the claim disappears while armed, or below 10 %
  battery while armed, with a 60 s grace after wake; it never changes a setting it did not arm.
- `bin/install.sh` and `bin/uninstall.sh`, run in a Herdr tab from the menu: the sudoers rule, the root helper, its
  state folder and the LaunchDaemon, with checked exit codes (0, 1, 2, 10, 20, 30; uninstall 0, 1, 40).
- Power adapter trigger: plugging in starts a session, unplugging ends only that session, and turning it off by hand
  while plugged in waits for the next unplug.
- The coffee chip for any layout (`{ "mod": "herdr-caffeinate" }`), the menu (mode, timer presets and minutes, time
  left, display, trigger, closed-lid with status and reason, safety settings, helper install state with Install and
  Uninstall), and the commands `toggle`, `mode:*`, `timer:<minutes>`, `timer:cancel`, `display:*`, `closed-lid:*`,
  `menu`, `refresh`, `install` and `uninstall`. `keys.json` binds ⌘⇧A to `mod.open:herdr-caffeinate`.
- The shared key `herdr-caffeinate.state` (and `state.json`) for other mods and scripts, and the hidden host window
  that lazuli opens to show the chip in its status bar.
- Korean and English, following the macOS language or the `language` setting.
- `settings.json` with `debug` and `fake` power facts for testing the safety rules live.
- Tests: the reducer, settings and commands, the probe parser on real macOS 27 output, both catalogs, the engine with
  fake processes and files, the fail-safe with fake `pmset`, `ioreg` and `sysctl`, and the installer's rendered sudoers
  and plist; a purity test for `core/`.
