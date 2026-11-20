// What every herdr-caffeinate view shares: the copy's plumbing around the engine (sys/index.js) and the small UI
// pieces the chip and the menu draw with. Every color, font and size comes from ui/tokens.js; every text arrives
// translated.
//
// Copy plumbing (C11): `attach` registers the copy and pumps its key commands (`nextCommand()`) into the engine,
// which lets only the first-registered copy handle one; `followLanguage` redraws the copy when the engine switches
// the UI language; `touch` (every render) restarts a stopped engine from a host or chip copy and pokes it.

import { div, svg } from "gpui-kit";
import { nextCommand } from "herdr";
import { onLanguageChange } from "../core/i18n.js";
import { iconPath } from "../ui/icons.js";
import { tokens } from "../ui/tokens.js";
import { engine } from "../sys/index.js";

export const TRANSPARENT = "#00000000";

// ── Copy plumbing ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Registers this copy with the engine (`role`: host, chip or menu) and hands its key commands to it. */
export function attach(role, cx) {
  const copy = engine.attach(role, cx);
  cx.spawn(async (cx) => {
    for (;;) {
      const text = await nextCommand();
      // Not awaited here: a slow command must not hold back the next one (the engine queues them in order).
      cx.spawn(async (cx) => {
        await engine.command(copy, text);
        cx.notify();
      });
    }
  });
  return copy;
}

let languageWait = null;

/** Resolves at the next UI language change (the engine applies settings.json `language`). */
function nextLanguageChange() {
  if (!languageWait) {
    languageWait = new Promise((resolve) => {
      const stop = onLanguageChange(() => {
        stop();
        languageWait = null;
        resolve();
      });
    });
  }
  return languageWait;
}

/** Redraws the copy after every language change. */
export function followLanguage(cx) {
  cx.spawn(async (cx) => {
    for (;;) {
      await nextLanguageChange();
      cx.notify();
    }
  });
}

/** Every render: (re)starts the engine from a host or chip copy when none runs, and pokes it (debounced). */
export function touch(copy, cx) {
  engine.ensure(copy, cx);
  engine.poke();
}

/** Runs an engine request from a click and redraws once it was handled. */
export function act(cx, request) {
  cx.spawn(async (cx) => {
    await request();
    cx.notify();
  });
}

// ── UI pieces ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Text style for a size step (`xs` … `xxl`) in the UI or the code font. */
export function type(el, k, size = "md", mono = false) {
  return el
    .font_family(mono ? k.fonts.mono : k.fonts.ui)
    .text_size(k.fontSize[size])
    .line_height(`${k.lineHeight[size]}px`);
}

/** Keeps a press on a control from dragging a window (the host and `window_drag` blocks). */
export const stopDrag = (_e, cx) => cx.stop_propagation();

/** A ui/icons/ glyph, tinted with `color` or the surrounding text color. */
export function Icon(name, { size, color } = {}) {
  const el = svg(iconPath(name)).size(size ?? tokens().icon.sm).flex_none();
  return color ? el.text_color(color) : el;
}

/** The color of a ui/tokens.js `status` tone (`off`, `active`, `waiting`, `starting`, `engaged`, `blocked`, …). */
export function toneColor(tone, k = tokens()) {
  return k.status[tone] ?? k.text.secondary;
}

/**
 * Text that wraps only between words. GPUI breaks Hangul between any two syllables ("시작하 / 지"), so each
 * space-separated word (어절) is its own unbreakable piece in a wrapping row, `gap` px apart (about one space of the
 * surrounding text). The text style comes from the parent.
 */
export function Words(text, { gap = 4 } = {}) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  return div()
    .flex()
    .flex_row()
    .flex_wrap()
    .gap_x(gap)
    .min_w(0)
    .children(words.map((word) => div().flex_none().whitespace_nowrap().child(word)));
}
