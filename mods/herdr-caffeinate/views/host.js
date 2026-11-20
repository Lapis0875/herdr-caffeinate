// The hidden host (C9, S2): a frameless 2×2 window lazuli opens on every services start, and a chip or menu copy opens
// when none is open. It draws nothing, keeps the engine running (it starts it unless another copy did) and receives
// `herdr-app do herdr-caffeinate.<command>` through `nextCommand()`. A press on it is stopped, so the invisible window
// is never dragged away.

import { div } from "gpui-kit";
import { engine } from "../sys/index.js";
import { attach, stopDrag, touch } from "./parts.js";

export default class HostView {
  init(_p, cx) {
    this.copy = attach("host", cx);
  }

  close() {
    engine.detach(this.copy);
  }

  render(cx) {
    touch(this.copy, cx);
    return div().id("hc-host").size_full().on_mouse_down("left", stopDrag);
  }
}
