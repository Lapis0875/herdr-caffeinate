// UI text for the closed-lid install state (C3 `install`) and the Install/Uninstall actions (C1),
// English. Keys start with "install.". `install.state.noSudo` = failsafe only, `noFailsafe` = sudo only.

export default {
  "install.title": "Closed-lid helper",
  "install.state.installed": "Installed",
  "install.state.missing": "Not installed",
  "install.state.noSudo": "Sudo rule missing",
  "install.state.noFailsafe": "Fail-safe not running",
  "install.state.checking": "Checking…",
  "install.hint": "Needs your admin password once: installs a sudo rule for pmset and a fail-safe that turns sleep back on if Herdr stops.",
  "install.install": "Install…",
  "install.reinstall": "Reinstall…",
  "install.uninstall": "Uninstall…",
};
