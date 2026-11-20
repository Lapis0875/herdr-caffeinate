// UI text for errors shown to the owner, English. Keys start with "error.".
// `{detail}` is the program's own message; `{script}` is `install.sh` or `uninstall.sh`.

export default {
  "error.timer.range": "Enter whole minutes from {min} to {max}",
  "error.settings.read": "settings.json could not be read, so defaults are in use",
  "error.settings.save": "Settings were not saved: {detail}",
  "error.holder": "caffeinate did not start: {detail}",
  "error.lid.engage": "Closed-lid mode could not turn on: the sleep setting did not change",
  "error.lid.restore": "Sleep could not be turned back on. Run in a terminal: sudo pmset -a disablesleep 0",
  "error.tab": "Could not open a tab for {script}",
};
