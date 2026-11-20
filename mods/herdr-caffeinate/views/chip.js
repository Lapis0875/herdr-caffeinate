// The coffee chip (A13, D6): a layout block `{ "mod": "herdr-caffeinate" }`, about 40 px, that shows whether the Mac
// is kept awake and opens the menu at the pointer when clicked (again: closes it).
//
// The coffee's tone and fill carry the state (ui/tokens.js `status`, ui/icons.js GLYPH): secondary at rest (Off),
// accent on a soft accent fill while awake (On, Agent with agents working, Timer, AC trigger), idle while Agent mode
// waits for an agent, tertiary while starting. A small dot marks closed-lid: accent while engaged, amber while
// blocked, unavailable or set by another app. With room (72 px or more) it adds words: the minutes left of a timer,
// else the mode. Its tooltip and accessibility label say all of it.
//
// A chip copy starts the engine and opens the hidden host when none is open (C11), checking again every 5 s.

import { div } from "gpui-kit";
import { h_flex, Button } from "gpui-base";
import { GLYPH } from "../ui/icons.js";
import { tokens } from "../ui/tokens.js";
import { engine, ensureHost } from "../sys/index.js";
import { chipLabel, chipTip, look } from "./describe.js";
import { openMenu } from "./menu.js";
import { Icon, TRANSPARENT, attach, followLanguage, stopDrag, toneColor, touch, type } from "./parts.js";

/** The chip shows words only from this block width (px) on. */
const LABEL_MIN_W = 72;
/** How often a chip checks for the host and for a new minute on a timer. */
const CHECK_MS = 5000;

export default class ChipView {
  init(_p, cx) {
    this.copy = attach("chip", cx);
    followLanguage(cx);
    ensureHost();
    this.width = null;
    this.shown = null;
    cx.timer.every(CHECK_MS, (cx) => {
      ensureHost();
      if (this.label() !== this.shown) cx.notify();
    });
  }

  close() {
    engine.detach(this.copy);
  }

  /** The words the chip shows now (null: the glyph alone). */
  label(L = look(engine.snapshot())) {
    return this.width === null || this.width >= LABEL_MIN_W ? chipLabel(L, Date.now()) : null;
  }

  render(cx) {
    touch(this.copy, cx);
    const k = tokens();
    const L = look(engine.snapshot());
    const tip = chipTip(L, Date.now());
    const label = this.label(L);
    this.shown = label;
    const lid = L.lid?.status ?? "off";
    const mark = lid === "off" ? null : toneColor(lid === "engaged" ? "engaged" : "blocked", k);
    const chip = type(Button.new("hc-chip").h_flex().tab_index(0), k, "sm")
      .relative()
      .flex_none()
      .h(k.chip.height)
      .px(k.chip.padX)
      .gap(k.chip.gap)
      .items_center()
      .rounded(k.chip.radius)
      .border_1()
      .border_color(TRANSPARENT)
      .bg(L.active ? k.chip.activeBg : TRANSPARENT)
      .text_color(toneColor(L.phase, k))
      .whitespace_nowrap()
      .accessibility_label(tip)
      .tooltip(tip)
      .child(Icon(GLYPH.chip, { size: k.chip.icon }))
      .when(Boolean(label), (e) => e.child(div().font_weight(k.weight.medium).child(label)))
      .when(Boolean(mark), (e) =>
        e.child(div().absolute().top(2).right(2).size(6).rounded(k.radius.full).bg(mark).border_1().border_color(k.bg.chrome)))
      .cursor_pointer()
      .on_mouse_down("left", stopDrag)
      .hover((s) => s.bg(L.active ? k.chip.activeHoverBg : k.chip.hoverBg))
      .focus((s) => s.border_color(k.chip.focusRing))
      .on_click(() => openMenu({ toggle: true }));
    return h_flex()
      .id("hc-chip-root")
      .size_full()
      .items_center()
      .justify_center()
      .on_size_change((size, cx) => {
        if (size.width === this.width) return;
        this.width = size.width;
        cx.notify();
      })
      .child(chip);
  }
}
