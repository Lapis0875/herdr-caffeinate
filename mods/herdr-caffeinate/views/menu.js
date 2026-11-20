// The menu popover (A13, D6): mode, timer presets and custom minutes, the time left, the display toggle, the AC
// trigger, closed-lid with its status and block reason, its safety settings (AC only, battery floor) and the
// closed-lid helper's install state with Install and Uninstall.
//
// It opens at the pointer as a frameless popup (it draws its own surface): from the chip, from the `menu` command
// (engine.setMenuOpener) and from `mod.open:herdr-caffeinate` (mod.json `overlay`). Every row has a fixed height and
// the surface is exactly as tall as its rows (`menuSize`), so the menu does not jump while its state changes; a
// frameless popup draws nothing outside it, so mod.json gives the tallest case. Changes go through the engine: C1
// commands (`perform`) for mode, timer, display and closed-lid, `update` for the other settings. The menu stays open
// after a change; Install and Uninstall close it (they open a tab).

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, Radio, Switch, Input, InputState } from "gpui-base";
import { closeOverlay, openOverlay, props } from "herdr";
import { BATTERY_FLOOR_MAX, BATTERY_FLOOR_MIN, MOD_ID, TIMER_MAX, TIMER_MIN } from "../core/state.js";
import { language, t } from "../core/i18n.js";
import { GLYPH, iconPath } from "../ui/icons.js";
import { tokens } from "../ui/tokens.js";
import { engine, ensureHost } from "../sys/index.js";
import { countdown, installKey, lidStatus, look, minutesLabel, modeWord, stateLine } from "./describe.js";
import { Icon, TRANSPARENT, Words, act, attach, followLanguage, stopDrag, toneColor, touch, type } from "./parts.js";

/** The battery floor moves in 5 % steps (C2 clamps it to 10..90). */
const FLOOR_STEP = 5;
/** How often an open menu redraws the countdown and picks up settings.json edits made outside Herdr. */
const TICK_MS = 1000;
/** A chip press that lands right after it closed the menu (an outside press) closes, not reopens. */
const TOGGLE_MS = 400;

// Row heights in px beside ui/tokens.js `menu.row` (28) and `menu.labelRow` (24).
const H = Object.freeze({
  header: 76, // 10 + title 20 + 2 + two description lines 36 + 8
  rule: 9, // 4 + 1 + 4
  tall: 44, // a row whose label may take two 18 px lines, + 4 above and below
  controls: 32, // a 24 px control row with 4 px above and below
  hint: 18,
  note: 40, // two 18 px lines + 4
});
const BORDER = 1;

/** The rows in order, as `[id, height]`. `suppressed`: the AC trigger waits for an unplug (adds its note). */
function rows({ suppressed = false } = {}) {
  const k = tokens();
  return [
    ["header", H.header],
    ["rule-1", H.rule],
    ["mode-label", k.menu.labelRow],
    ["mode-off", k.menu.row],
    ["mode-on", k.menu.row],
    ["mode-agent", k.menu.row],
    ["timer", k.menu.row],
    ["timer-presets", H.controls],
    ["timer-hint", H.hint],
    ["rule-2", H.rule],
    ["display", k.menu.row],
    ["trigger", H.tall],
    ...(suppressed ? [["trigger-note", H.note]] : []),
    ["rule-3", H.rule],
    ["lid", k.menu.row],
    ["lid-status", H.note],
    ["safety-label", k.menu.labelRow],
    ["ac-only", k.menu.row],
    ["floor", k.menu.row],
    ["rule-4", H.rule],
    ["install", k.menu.row],
    ["install-actions", H.controls],
  ];
}

/** Whether the AC-trigger note shows: the trigger is on and a user Off on AC suppressed it until the next unplug. */
function triggerSuppressed(snap) {
  return snap?.trigger?.suppressed === true && snap.settings?.trigger?.ac?.enabled === true;
}

/** The menu surface's size: `{width, height}` in px, for a snapshot's rows or (`tallest`) every row there can be.
 *  The popup always opens at the tallest size: a frameless popup draws nothing beyond the surface, so a row that
 *  appears while it is open is never cut off. */
export function menuSize(snap = engine.snapshot(), { tallest = false } = {}) {
  const k = tokens();
  const list = rows({ suppressed: tallest || triggerSuppressed(snap) });
  const height = list.reduce((sum, [, h]) => sum + h, 0) + k.menu.gap * (list.length - 1) + 2 * (k.menu.pad + BORDER);
  return { width: k.menu.width, height };
}

let openId = null;
let closedAt = -Infinity;

/** Opens the menu at the pointer, replacing an open one. `toggle` (the chip): a press while it is open, or the press
 *  that just closed it, closes it instead. Returns the overlay id, or null. */
export function openMenu({ toggle = false } = {}) {
  if (toggle && (openId !== null || Date.now() - closedAt < TOGGLE_MS)) {
    if (openId !== null) closeMenu(openId);
    closedAt = -Infinity;
    return null;
  }
  if (openId !== null) closeMenu(openId);
  const { width, height } = menuSize(undefined, { tallest: true });
  openId = openOverlay({ mod: MOD_ID, props: { view: "menu" }, kind: "popup", frame: "none", width, height });
  return openId;
}

function closeMenu(id) {
  if (openId === id) openId = null;
  try {
    closeOverlay(id);
  } catch (e) {
    console.log(`[${MOD_ID}] menu did not close: ${e?.message ?? e}`);
  }
}

const isMinutes = (text) => /^[1-9][0-9]{0,3}$/.test(text) && Number(text) >= TIMER_MIN && Number(text) <= TIMER_MAX;

export default class MenuView {
  init(p, cx) {
    this.overlay = p?.overlay ?? props()?.overlay ?? null;
    if (this.overlay) openId = this.overlay;
    this.copy = attach("menu", cx);
    followLanguage(cx);
    ensureHost();
    act(cx, () => engine.menu());
    this.handle = cx.focus_handle();
    this.handle.focus();
    const last = engine.snapshot().settings?.timer?.lastCustomMin;
    this.minutes = InputState.new({ placeholder: String(last ?? 45), value: String(last ?? 45) });
    this.invalid = false;
    this.minutes.on("change", (_e, cx) => {
      if (!this.invalid) return;
      this.invalid = false;
      cx.notify();
    });
    this.minutes.on("submit", (_e, cx) => this.startCustom(cx));
    this.sig = "";
    cx.timer.every(TICK_MS, (cx) => {
      engine.poke();
      if (this.signature() !== this.sig) cx.notify();
    });
  }

  close() {
    engine.detach(this.copy);
    if (openId === this.overlay) openId = null;
    closedAt = Date.now();
  }

  /** What the menu shows, as text: it redraws only when this changes. */
  signature() {
    const snap = engine.snapshot();
    const L = look(snap);
    return JSON.stringify([language(), snap.running, snap.shared && { ...snap.shared, at: 0 }, snap.settings, snap.install, countdown(L, Date.now()), triggerSuppressed(snap)]);
  }

  dismiss() {
    if (this.overlay) closeMenu(this.overlay);
  }

  startCustom(cx) {
    const text = this.minutes.value().trim();
    if (!isMinutes(text)) {
      this.invalid = true;
      cx.notify();
      return;
    }
    this.invalid = false;
    act(cx, () => engine.perform(`timer:${Number(text)}`));
  }

  render(cx) {
    touch(this.copy, cx);
    this.sig = this.signature();
    const k = tokens();
    const snap = engine.snapshot();
    const L = look(snap);
    const now = Date.now();
    const build = {
      header: () => this.header(L, now),
      "mode-label": () => this.label(t("menu.mode")),
      "mode-off": () => this.mode(L, "off"),
      "mode-on": () => this.mode(L, "on"),
      "mode-agent": () => this.mode(L, "agent"),
      timer: () => this.timer(L, now),
      "timer-presets": () => this.presets(L),
      "timer-hint": () => this.timerHint(),
      display: () => this.switchRow("hc-display", GLYPH.display, t("menu.display"), L.settings?.display === true, L, (on, cx) =>
        act(cx, () => engine.perform(`display:${on ? "on" : "off"}`))),
      trigger: () => this.switchRow("hc-trigger", GLYPH.acTrigger, t("menu.trigger"), L.settings?.trigger?.ac?.enabled === true, L, (on, cx) =>
        act(cx, () => engine.update((s) => {
          s.trigger.ac.enabled = on;
        })), { wrap: true }),
      "trigger-note": () => this.note(t("menu.trigger.suppressed"), k.text.tertiary),
      lid: () => this.switchRow("hc-lid", GLYPH.closedLid, t("menu.lid"), L.settings?.closedLid?.enabled === true, L, (on, cx) =>
        act(cx, () => engine.perform(`closed-lid:${on ? "on" : "off"}`))),
      "lid-status": () => this.lidStatus(L),
      "safety-label": () => this.label(t("menu.safety")),
      "ac-only": () => this.switchRow("hc-ac-only", GLYPH.acOnly, t("menu.acOnly"), L.settings?.closedLid?.acOnly === true, L, (on, cx) =>
        act(cx, () => engine.update((s) => {
          s.closedLid.acOnly = on;
        }))),
      floor: () => this.floor(L),
      install: () => this.install(L),
      "install-actions": () => this.installActions(L),
    };
    const suppressed = triggerSuppressed(snap);
    const { width, height } = menuSize(snap);
    const body = rows({ suppressed }).map(([id, h]) => (id.startsWith("rule-") ? this.rule(id) : build[id]()).h(h).flex_none());
    return type(v_flex().id("hc-menu"), k, "md")
      .w(width)
      .h(height)
      .flex_none()
      .p(k.menu.pad)
      .gap(k.menu.gap)
      .rounded(k.menu.radius)
      .bg(k.menu.bg)
      .border_1()
      .border_color(k.menu.border)
      .shadow_md()
      .text_color(k.text.primary)
      .role("dialog")
      .accessibility_label(t("menu.title"))
      .track_focus(this.handle)
      .children(body);
  }

  // ── Rows ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  header(L, now) {
    const k = tokens();
    const tone = toneColor(L.phase, k);
    const word = modeWord(L);
    const badge = div()
      .flex_none()
      .size(28)
      .flex()
      .items_center()
      .justify_center()
      .rounded(k.radius.md)
      .bg(L.active ? k.chip.activeBg : k.bg.surface)
      .child(L.phase === "starting"
        ? svg(iconPath(GLYPH.starting)).size(k.icon.md).flex_none().text_color(tone).spin(900)
        : Icon(GLYPH.chip, { size: k.icon.md, color: tone }));
    const pill = word && type(h_flex(), k, "xs")
      .flex_none()
      .h(20)
      .px(8)
      .gap(4)
      .items_center()
      .rounded(k.radius.full)
      .bg(L.active ? k.chip.activeBg : k.bg.surface)
      .text_color(tone)
      .font_weight(k.weight.medium)
      .whitespace_nowrap()
      .when(L.reason === "trigger", (e) => e.child(Icon(GLYPH.acTrigger, { size: 12 })))
      .child(word);
    const description = L.settingsOk ? stateLine(L, countdown(L, now)) : t("error.settings.read");
    return h_flex()
      .px(k.menu.itemPadX)
      .pt(10)
      .pb(8)
      .gap(10)
      .items_start()
      .child(badge)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .h(20)
              .gap(8)
              .items_center()
              .child(type(div(), k, "md").flex_1().min_w(0).truncate().font_weight(k.weight.semibold).child(t("menu.title")))
              .when(Boolean(pill), (e) => e.child(pill)),
          )
          .child(
            type(div(), k, "sm")
              .h(36)
              .overflow_hidden()
              .text_color(L.settingsOk ? k.text.secondary : k.state.warning)
              .role(L.settingsOk ? "status" : "alert")
              .child(Words(description, { gap: 3 })),
          ),
      );
  }

  rule(id) {
    const k = tokens();
    return div().id(id).py(4).w_full().child(div().h(1).w_full().bg(k.line.soft));
  }

  label(text) {
    const k = tokens();
    return type(div(), k, "xs")
      .px(k.menu.itemPadX)
      .flex()
      .items_center()
      .text_color(k.text.tertiary)
      .font_weight(k.weight.medium)
      .child(text);
  }

  /** A row's look: md text, its glyph in `iconColor`, the label (one truncated line, or up to two with `wrap`),
   *  then trailing elements. */
  rowShell(el, { icon, iconColor, label, trailing = [], wrap = false }) {
    const k = tokens();
    const words = wrap
      ? div().flex_1().min_w(0).max_h(36).overflow_hidden().line_height("18px").child(Words(label))
      : div().flex_1().min_w(0).truncate().child(label);
    return type(el, k, "md")
      .w_full()
      .px(k.menu.itemPadX)
      .gap(k.menu.itemGap)
      .items_center()
      .rounded(k.menu.itemRadius)
      .border_1()
      .border_color(TRANSPARENT)
      .text_color(k.text.primary)
      .child(Icon(icon, { size: k.menu.icon, color: iconColor ?? k.text.secondary }))
      .child(words)
      .children(trailing);
  }

  /** Off, On or Agent: one radio of the mode group. */
  mode(L, mode) {
    const k = tokens();
    const current = L.mode === mode;
    const disabled = !L.settings;
    const el = this.rowShell(Radio.new(`hc-mode-${mode}`).h_flex(), {
      icon: GLYPH.mode[mode],
      iconColor: current ? toneColor(L.phase, k) : k.text.secondary,
      label: t(`mode.${mode}`),
      trailing: current ? [Icon(GLYPH.checked, { size: k.menu.icon, color: k.accent })] : [],
    })
      .checked(current)
      .disabled(disabled)
      .set_position(["off", "on", "agent"].indexOf(mode) + 1, 3)
      .accessibility_label(`${t(`mode.${mode}`)}: ${t(`mode.${mode}.hint`)}`)
      .tooltip(t(`mode.${mode}.hint`))
      .when(current, (e) => e.font_weight(k.weight.medium));
    if (disabled) return el.opacity(0.5);
    return el
      .cursor_pointer()
      .on_mouse_down("left", stopDrag)
      .hover((s) => s.bg(k.menu.hoverBg))
      .focus((s) => s.border_color(k.menu.focusRing))
      .on_change((_on, cx) => act(cx, () => engine.perform(`mode:${mode}`)));
  }

  /** The timer row: checked while a timer runs, with its countdown and a cancel button. */
  timer(L, now) {
    const k = tokens();
    const running = L.mode === "timer" && L.endsAt !== null;
    const trailing = running
      ? [
        type(div(), k, "sm", true).flex_none().text_color(k.accent).font_weight(k.weight.medium).child(t("timer.remaining", { time: countdown(L, now) })),
        this.iconButton("hc-timer-cancel", GLYPH.timerCancel, t("timer.cancel"), (cx) => act(cx, () => engine.perform("timer:cancel"))),
      ]
      : [];
    return this.rowShell(h_flex().id("hc-timer"), {
      icon: GLYPH.mode.timer,
      iconColor: running ? toneColor(L.phase, k) : k.text.secondary,
      label: t("mode.timer"),
      trailing,
    })
      .tooltip(t("mode.timer.hint"))
      .when(running, (e) => e.font_weight(k.weight.medium));
  }

  /** The first three presets (all the 300 px row holds beside the custom field), then custom minutes and Start. */
  presets(L) {
    const k = tokens();
    const disabled = !L.settings;
    const presets = L.settings?.timer?.presetsMin ?? [15, 60, 120];
    const field = h_flex()
      .id("hc-minutes")
      .flex_none()
      .w(52)
      .h(k.control.sm)
      .px(6)
      .items_center()
      .rounded(k.radius.md)
      .border_1()
      .border_color(this.invalid ? k.state.error : k.line.strong)
      .bg(k.bg.card)
      .cursor_text()
      .accessibility_label(`${t("timer.custom")} ${t("timer.customLabel")}`)
      .tooltip(t("timer.customHint", { min: TIMER_MIN, max: TIMER_MAX }))
      .on_mouse_down("left", stopDrag)
      .on_click(() => this.minutes.focus())
      .child(Input.new(this.minutes).flex_1().min_w(0).h_full().font_family(k.fonts.mono).text_size(k.fontSize.sm).text_color(k.text.primary));
    return h_flex()
      .px(k.menu.itemPadX)
      .gap(6)
      .items_center()
      .children(presets.slice(0, 3).map((n) =>
        this.button(`hc-preset-${n}`, minutesLabel(n), { disabled, onClick: (cx) => act(cx, () => engine.perform(`timer:${n}`)) })))
      .child(div().flex_1())
      .child(disabled ? field.opacity(0.5) : field)
      .child(this.button("hc-custom-start", t("timer.start"), { disabled, onClick: (cx) => this.startCustom(cx) }));
  }

  timerHint() {
    const k = tokens();
    const range = { min: TIMER_MIN, max: TIMER_MAX };
    return type(div(), k, "xs")
      .px(k.menu.itemPadX)
      .flex()
      .items_center()
      .justify_end()
      .text_color(this.invalid ? k.state.error : k.text.tertiary)
      .when(this.invalid, (e) => e.role("alert"))
      .child(this.invalid ? t("error.timer.range", range) : t("timer.customHint", range));
  }

  /** A whole-row switch: the label and the track toggle it. `wrap`: the label may take two lines. */
  switchRow(id, icon, label, on, L, onChange, { wrap = false } = {}) {
    const k = tokens();
    const disabled = !L.settings;
    const track = div()
      .flex_none()
      .w(28)
      .h(16)
      .p(2)
      .flex()
      .items_center()
      .rounded(k.radius.full)
      .bg(on ? k.accent : k.line.strong)
      .when(on, (e) => e.justify_end())
      .child(div().size(12).rounded(k.radius.full).bg(on ? k.text.onAccent : k.text.secondary));
    const el = this.rowShell(Switch.new(id).h_flex(), { icon, label, trailing: [track], wrap })
      .checked(on)
      .disabled(disabled)
      .accessibility_label(label)
      .tooltip(label);
    if (disabled) return el.opacity(0.5);
    return el
      .cursor_pointer()
      .on_mouse_down("left", stopDrag)
      .hover((s) => s.bg(k.menu.hoverBg))
      .focus((s) => s.border_color(k.menu.focusRing))
      .on_change((value, cx) => onChange(value, cx));
  }

  /** Two lines of small text under a row, aligned with its label. */
  note(text, color, glyph) {
    const k = tokens();
    const indent = k.menu.itemPadX + k.menu.icon + k.menu.itemGap;
    return h_flex()
      .pl(glyph ? k.menu.itemPadX : indent)
      .pr(k.menu.itemPadX)
      .gap(k.menu.itemGap)
      .items_start()
      .text_color(color)
      .when(Boolean(glyph), (e) => e.child(div().flex_none().w(k.menu.icon).h(18).flex().items_center().justify_center().child(Icon(glyph, { size: 12 }))))
      .child(type(div(), k, "sm").flex_1().min_w(0).h(36).overflow_hidden().child(Words(text, { gap: 3 })));
  }

  /** The closed-lid status under its switch; its glyph (the block reason's) shows only when it is not off. */
  lidStatus(L) {
    const k = tokens();
    const s = lidStatus(L);
    const off = s.tone === "off";
    return this.note(s.text, off ? k.text.tertiary : toneColor(s.tone, k), off ? null : s.glyph).role("status");
  }

  /** The battery floor: its words and a − / + stepper (5 % steps, 10..90). */
  floor(L) {
    const k = tokens();
    const floor = L.settings?.closedLid?.batteryFloor ?? 20;
    const disabled = !L.settings;
    const set = (next) => (cx) => act(cx, () => engine.update((s) => {
      s.closedLid.batteryFloor = next;
    }));
    const down = Math.max(BATTERY_FLOOR_MIN, floor - FLOOR_STEP);
    const up = Math.min(BATTERY_FLOOR_MAX, floor + FLOOR_STEP);
    const label = t("menu.batteryFloor", { percent: floor });
    return this.rowShell(h_flex().id("hc-floor"), {
      icon: GLYPH.batteryFloor,
      label,
      trailing: [
        h_flex()
          .flex_none()
          .gap(k.space.xxs)
          .child(this.iconButton("hc-floor-down", GLYPH.decrease, t("menu.batteryFloor", { percent: down }), set(down), { disabled: disabled || floor <= BATTERY_FLOOR_MIN }))
          .child(this.iconButton("hc-floor-up", GLYPH.increase, t("menu.batteryFloor", { percent: up }), set(up), { disabled: disabled || floor >= BATTERY_FLOOR_MAX })),
      ],
    })
      .role("group")
      .accessibility_label(label)
      .tooltip(label);
  }

  install(L) {
    const k = tokens();
    const key = installKey(L.install);
    const ready = key === "installed";
    const color = key === "checking" ? k.text.tertiary : ready ? k.status.installed : k.status.missing;
    return this.rowShell(h_flex().id("hc-install"), {
      icon: ready ? GLYPH.install.ready : GLYPH.install.missing,
      iconColor: color,
      label: t("install.title"),
      trailing: [type(div(), k, "sm").flex_none().whitespace_nowrap().text_color(color).child(t(`install.state.${key}`))],
    }).tooltip(t("install.hint"));
  }

  installActions(L) {
    const k = tokens();
    const key = installKey(L.install);
    const known = key !== "checking";
    const some = known && (L.install.sudo || L.install.failsafe);
    const run = (name) => (cx) => {
      act(cx, () => engine.perform(name));
      this.dismiss();
    };
    return h_flex()
      .pl(k.menu.itemPadX + k.menu.icon + k.menu.itemGap)
      .pr(k.menu.itemPadX)
      .gap(6)
      .items_center()
      .child(this.button("hc-install-run", t(key === "installed" ? "install.reinstall" : "install.install"), {
        icon: GLYPH.installAction,
        primary: known && key !== "installed",
        disabled: !known,
        tooltip: t("install.hint"),
        onClick: run("install"),
      }))
      .child(this.button("hc-uninstall-run", t("install.uninstall"), {
        icon: GLYPH.uninstallAction,
        disabled: !some,
        onClick: run("uninstall"),
      }));
  }

  // ── Controls ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A small text button (24 px): secondary (bordered) or `primary` (solid). */
  button(id, label, { icon, primary = false, disabled = false, tooltip, onClick } = {}) {
    const k = tokens();
    let el = type(Button.new(id).h_flex().tab_index(0), k, "sm")
      .flex_none()
      .h(k.control.sm)
      .px(8)
      .gap(4)
      .items_center()
      .rounded(k.radius.md)
      .border_1()
      .border_color(primary ? k.button.bg : k.line.strong)
      .bg(primary ? k.button.bg : k.bg.card)
      .text_color(primary ? k.button.text : k.text.primary)
      .whitespace_nowrap()
      .when(primary, (e) => e.font_weight(k.weight.semibold))
      .accessibility_label(tooltip ? `${label} ${tooltip}` : label)
      .disabled(disabled)
      .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
      .when(Boolean(icon), (e) => e.child(Icon(icon, { size: 12 })))
      .child(label);
    if (disabled) return el.opacity(0.5).cursor_default();
    el = el
      .cursor_pointer()
      .on_mouse_down("left", stopDrag)
      .hover((s) => (primary ? s.opacity(0.9) : s.bg(k.bg.hover)))
      .active((s) => (primary ? s.opacity(0.8) : s.bg(k.bg.selected)))
      .focus((s) => s.border_color(primary ? k.text.primary : k.menu.focusRing));
    return onClick ? el.on_click((_e, cx) => onClick(cx)) : el;
  }

  /** An icon-only button (24 px); `label` is announced and shown as its tooltip. */
  iconButton(id, icon, label, onClick, { disabled = false } = {}) {
    const k = tokens();
    let el = Button.new(id)
      .h_flex()
      .tab_index(0)
      .flex_none()
      .size(k.control.sm)
      .items_center()
      .justify_center()
      .rounded(k.radius.md)
      .border_1()
      .border_color(TRANSPARENT)
      .text_color(k.text.secondary)
      .accessibility_label(label)
      .tooltip(label)
      .disabled(disabled)
      .child(Icon(icon, { size: k.menu.icon }));
    if (disabled) return el.opacity(0.4).cursor_default();
    el = el
      .cursor_pointer()
      .on_mouse_down("left", stopDrag)
      .hover((s) => s.bg(k.bg.hover).text_color(k.text.primary))
      .active((s) => s.bg(k.bg.selected))
      .focus((s) => s.border_color(k.menu.focusRing));
    return el.on_click((_e, cx) => onClick(cx));
  }
}
