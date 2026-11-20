// herdr-caffeinate's design tokens: the only module that reads `theme()`, `settings()` and `fonts()`.
// Views take every color, font and size from `tokens()`.
//
// The look follows lazuli's direction A · Lapis (calm and dense: 13 px base text, 28 px rows, 24 px status
// items) with the same scales, but this file is standalone: herdr-caffeinate imports nothing from lazuli.
// Colors come from the theme Herdr shows (lazuli-dark/-light in the lazuli layout, any other theme
// elsewhere); light and dark themes name the same colors, so one set of names follows both appearances.
//
// Layers: scales (fixed numbers) → semantic colors (from the theme) → this mod's status tones and the
// chip/menu component tokens, which use only the two layers above.

import { theme, settings, fonts } from "herdr";

/** Spacing steps in px. */
export const SPACE = Object.freeze({ xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 });

/** Corner radii in px. `full` makes pills and dots. */
export const RADIUS = Object.freeze({ sm: 4, md: 6, lg: 10, full: 999 });

/** Text sizes in px; `md` (13) is the base. */
export const FONT_SIZE = Object.freeze({ xs: 11, sm: 12, md: 13, lg: 15, xl: 18, xxl: 22 });

/** Line height in px for each text size. */
export const LINE_HEIGHT = Object.freeze({ xs: 16, sm: 18, md: 20, lg: 22, xl: 26, xxl: 28 });

/** Font weights. The UI fonts below bring no italic: emphasis is weight or color. */
export const WEIGHT = Object.freeze({ regular: 400, medium: 500, semibold: 600, bold: 700 });

/** List and menu row heights in px; `md` (28) is the default row. */
export const ROW = Object.freeze({ sm: 24, md: 28, lg: 32 });

/** Icon sizes in px: `sm` in rows and the chip, `md` in banners and headers. */
export const ICON = Object.freeze({ sm: 14, md: 16 });

/** Heights in px: `chip` (non-interactive tags and badges), then controls: `sm` the status chip and small
 *  buttons, `md` buttons, inputs, steppers and segmented controls, `lg` large buttons. */
export const CONTROL = Object.freeze({ chip: 20, sm: 24, md: 26, lg: 32 });

/** UI font when neither the layout nor settings.json names one: the first installed of these. Geist ships
 *  with Herdr, so the chain always ends on an available family. */
export const UI_FONT_FALLBACK = Object.freeze(["Pretendard", "Apple SD Gothic Neo", "Geist"]);

/** Code font for minutes and the remaining time, the first installed of these; JetBrains Mono ships with
 *  Herdr. */
export const MONO_FONT_FALLBACK = Object.freeze(["D2Coding ligature", "D2Coding", "JetBrains Mono"]);

/** `#rrggbb` with an alpha from 0 to 1 appended: `#rrggbbaa` (gpui-kit `Color`). Other inputs come back as given. */
export function withAlpha(color, alpha) {
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${color}${a.toString(16).padStart(2, "0")}`;
}

/** The token set for a theme's colors (`theme()`), a settings object (`settings()`) and a predicate telling
 *  whether a font family is installed. Pure: `tokens()` feeds it the live values. */
export function buildTokens(c, s, installed) {
  const firstInstalled = (chain) => chain.slice(0, -1).find((f) => installed(f)) || chain[chain.length - 1];
  const accent = c.accent;
  const text = Object.freeze({
    primary: c.foreground,
    secondary: c.muted,
    tertiary: c.dim,
    onAccent: c.accent_foreground,
  });
  const bg = Object.freeze({
    app: c.canvas,
    chrome: c.chrome,
    card: c.background,
    surface: c.surface,
    raised: c.raised,
    popover: c.popover,
    hover: c.hover,
    selected: c.selected,
  });
  const line = Object.freeze({ soft: c.border, strong: c.input });
  const state = Object.freeze({
    working: c.working,
    blocked: c.blocked,
    done: c.done,
    idle: c.idle,
    unknown: c.unknown,
    // Message tones: success = done, warning = blocked, error = ansi red, info = accent.
    success: c.done,
    warning: c.blocked,
    error: c.ansi1,
    info: accent,
  });
  // One color per fact the chip and the menu show. Accent means "keeping the Mac awake" and nothing else,
  // amber means "wanted but held back", green means "ready"; red stays for failures (state.error).
  const status = Object.freeze({
    off: text.secondary, // mode Off: the Mac sleeps as usual
    active: accent, // awake now: On, Agent while an agent works, Timer, AC trigger
    waiting: c.idle, // Agent mode with no agent working: armed, not holding
    starting: text.tertiary, // no fresh shared state yet (missing, stale or another `v`)
    engaged: accent, // closed-lid is keeping the Mac awake with the lid shut
    blocked: c.blocked, // closed-lid wanted but cut off (AC, battery, thermal, unknown, other instance)
    unavailable: c.blocked, // closed-lid needs Install, or its readback failed
    external: c.blocked, // another tool disabled sleep; herdr-caffeinate holds no claim
    installed: c.done, // sudo rule and fail-safe both present
    missing: c.blocked, // either one is missing
  });
  const fontsSet = Object.freeze({
    ui: (typeof s.ui_font_family === "string" && s.ui_font_family) || firstInstalled(UI_FONT_FALLBACK),
    mono: firstInstalled(MONO_FONT_FALLBACK),
  });
  // The status chip: a 24 px status-bar item (lazuli's status items: 24 px, 6 px padding, 6 px gap, md
  // radius). At rest it is a bare glyph in secondary text; active adds a soft accent fill so the state
  // reads without relying on hue alone. Both fill alphas keep accent text at 4.5:1 or more on the Lapis
  // themes' chrome.
  const chip = Object.freeze({
    height: CONTROL.sm,
    padX: SPACE.sm,
    gap: SPACE.sm,
    radius: RADIUS.md,
    icon: ICON.sm,
    textSize: FONT_SIZE.sm,
    hoverBg: bg.hover,
    activeBg: withAlpha(accent, 0.1),
    activeHoverBg: withAlpha(accent, 0.13),
    focusRing: c.ring || accent,
  });
  // The popover menu: popover fill, soft border, md shadow (drawn by the view), lg radius, 28 px rows.
  const menu = Object.freeze({
    width: 300,
    pad: SPACE.xs,
    gap: 1,
    radius: RADIUS.lg,
    itemRadius: RADIUS.md,
    row: ROW.md,
    labelRow: ROW.sm,
    itemPadX: SPACE.md,
    itemGap: SPACE.md,
    icon: ICON.sm,
    control: CONTROL.md,
    bg: bg.popover,
    border: line.soft,
    hoverBg: bg.hover,
    selectedBg: bg.selected,
    focusRing: c.ring || accent,
  });
  return Object.freeze({
    dark: Boolean(s.dark),
    bg,
    line,
    text,
    selection: c.selection,
    accent,
    ring: c.ring || accent,
    button: Object.freeze({ bg: c.solid, text: c.solid_foreground }),
    state,
    status,
    chip,
    menu,
    fonts: fontsSet,
    space: SPACE,
    radius: RADIUS,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    weight: WEIGHT,
    row: ROW,
    icon: ICON,
    control: CONTROL,
  });
}

let families = null;
function installed(family) {
  if (!families) {
    try {
      families = new Set(fonts());
    } catch {
      families = new Set();
    }
  }
  return families.has(family);
}

let memo = null;
let memoKey = "";

/** The tokens for the shown theme and fonts. Cheap to call in every render: it rebuilds only after the
 *  theme's colors, the UI font or the appearance change. */
export function tokens() {
  const c = theme() ?? {};
  const s = settings() ?? {};
  const key = `${Object.values(c).join(",")}|${s.ui_font_family ?? ""}|${s.dark ? 1 : 0}`;
  if (memo && key === memoKey) return memo;
  memo = buildTokens(c, s, installed);
  memoKey = key;
  return memo;
}
