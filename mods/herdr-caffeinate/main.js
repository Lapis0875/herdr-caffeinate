// herdr-caffeinate: keep the Mac awake from Herdr, lid closed included. One mod, three views chosen by
// `props().view` (A13, C9, C11):
// - `chip`: the coffee chip, the default for a layout block `{ "mod": "herdr-caffeinate" }`;
// - `menu`: the popover, also what `mod.open:herdr-caffeinate` opens (mod.json `overlay`; its props carry only
//   `overlay`);
// - `host`: the hidden 2×2 window lazuli (or a chip or menu copy) opens; it keeps the engine running and receives
//   `herdr-app do herdr-caffeinate.<command>`.
// The engine (sys/) is a module-scope singleton every copy registers with; the views draw its snapshot.

import { View } from "gpui-kit";
import { props } from "herdr";
import { engine } from "./sys/index.js";
import ChipView from "./views/chip.js";
import HostView from "./views/host.js";
import MenuView, { openMenu } from "./views/menu.js";

/** Every view by its `view` prop. */
export const VIEWS = Object.freeze({ chip: ChipView, menu: MenuView, host: HostView });

/** The view for a copy's props: `view` when known, else the menu for an overlay and the chip for a block. */
export function viewName(p) {
  const v = p?.view;
  if (typeof v === "string" && Object.prototype.hasOwnProperty.call(VIEWS, v)) return v;
  return p?.overlay ? "menu" : "chip";
}

export default class HerdrCaffeinate extends View {
  init(p, cx) {
    engine.setMenuOpener(() => openMenu());
    const given = p ?? props() ?? {};
    this.impl = new VIEWS[viewName(given)]();
    this.impl.init(given, cx);
  }

  render(cx) {
    return this.impl.render(cx);
  }

  close(cx) {
    this.impl?.close?.(cx);
  }
}
