// herdr-caffeinate's glyphs: Lucide icons (ISC, ui/icons/LICENSE-Lucide.txt) drawn at stroke width 1.75 like
// lazuli's set. `svg(iconPath(name))` tints them with the text color (H/AGENTS.md, "Images and SVGs are
// referenced from ~/.config/herdr-app"). Keys follow the C3 shared-state values, so a view looks a glyph up
// by the value it shows: one glyph per mode, closed-lid status and block reason.

/** ui/icons/ as a path in the app home, where `svg()` resolves it. */
export const ICONS_DIR = "mods/herdr-caffeinate/ui/icons";

/** The path of a glyph under ui/icons/. */
export function iconPath(name) {
  return `${ICONS_DIR}/${name}.svg`;
}

/** Every glyph shipped in ui/icons/, by its file name. `shield-alert` is Lucide's alias of
 *  `shield-exclamation-point`; `loader` is Lucide's `loader-circle` arc. */
export const ICON_NAMES = Object.freeze([
  "battery-low",
  "bot",
  "check",
  "circle-help",
  "coffee",
  "download",
  "hourglass",
  "laptop",
  "loader",
  "lock",
  "minus",
  "monitor",
  "moon",
  "plug",
  "plug-zap",
  "plus",
  "shield-alert",
  "shield-check",
  "thermometer",
  "timer",
  "trash-2",
  "triangle-alert",
  "x",
]);

/** The glyph for each fact the chip and the menu show. The chip is always `coffee`; its tone (tokens
 *  `status`) carries the state. There is no filled "active" coffee: active is the accent tone and fill. */
export const GLYPH = Object.freeze({
  chip: "coffee",
  /** C3 `mode`. */
  mode: Object.freeze({ off: "moon", on: "coffee", agent: "bot", timer: "timer" }),
  /** The remaining time of a timer session. */
  remaining: "hourglass",
  timerCancel: "x",
  display: "monitor",
  closedLid: "laptop",
  /** C3 `closedLid.status`; `blocked` shows the reason's glyph from `blocked` below instead. */
  closedLidStatus: Object.freeze({
    off: "laptop",
    engaged: "laptop",
    unavailable: "shield-alert",
    external: "triangle-alert",
  }),
  /** C3 `closedLid.blocked`. */
  blocked: Object.freeze({
    ac: "plug",
    battery: "battery-low",
    thermal: "thermometer",
    unknown: "circle-help",
    "other-instance": "lock",
  }),
  /** C3 `install`: both parts present, or not. */
  install: Object.freeze({ ready: "shield-check", missing: "shield-alert" }),
  acOnly: "plug",
  batteryFloor: "battery-low",
  acTrigger: "plug-zap",
  installAction: "download",
  uninstallAction: "trash-2",
  /** A chosen option in the menu (mode, timer preset). */
  checked: "check",
  /** No fresh shared state yet: the loader arc, spun with `svg(…).spin(900)`. */
  starting: "loader",
  increase: "plus",
  decrease: "minus",
});
