// UI text for closed-lid mode, English. Keys start with "lid.".
// `lid.status.<status>` covers every C3 `closedLid.status`; `lid.block.<reason>` covers every block
// reason of C10 (the C3 `closedLid.blocked` values plus `external` and `unavailable`).

export default {
  "lid.status.off": "Off",
  "lid.status.engaged": "On",
  "lid.status.blocked": "Paused",
  "lid.status.unavailable": "Unavailable",
  "lid.status.external": "Set by another app",
  "lid.waiting": "Turns on while the Mac is kept awake",
  "lid.paused": "Paused: {reason}",
  "lid.block.ac": "On battery; set to run only on the power adapter",
  "lid.block.battery": "Battery below {floor}%",
  "lid.block.thermal": "The Mac is running hot",
  "lid.block.unknown": "Power state can't be read",
  "lid.block.other-instance": "Another Herdr is using it",
  "lid.block.external": "Another app already keeps the Mac from sleeping",
  "lid.block.unavailable": "The sleep setting can't be changed",
};
