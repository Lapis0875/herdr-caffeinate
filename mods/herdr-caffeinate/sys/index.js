// The engine bound to Herdr (C11), for views/ and main.js. No host call runs at import: the bindings are read when
// the engine starts.
//
// Use from a copy:
//   init(props, cx):  this.copy = engine.attach(role, cx)   // role "host" | "chip" | "menu"
//                     host/chip: starts the engine unless checking(); chip/menu: ensureHost() when none is open
//                     menu: engine.menu()                    // a probe and a step at once
//                     cx.spawn(async (cx) => { for (;;) { await engine.command(this.copy, await nextCommand()); cx.notify(); } })
//   render(cx):       engine.ensure(this.copy, cx); engine.poke(); draw engine.snapshot() / shared(SHARED_KEY)
//   close():          engine.detach(this.copy)              // releases nothing
//   menu changes:     await engine.update((settings) => { settings.closedLid.acOnly = false; }); cx.notify()
//   menu clicks:      await engine.perform("mode:on"); cx.notify()   // C1 commands without copy routing

import * as fs from "fs/promises";
import {
  appHome, checking, exec, home, notify, openOverlay, readTextFile, run, setShared, terminals, writeTextFile,
} from "herdr";
import { MOD_ID } from "../core/state.js";
import { createEngine } from "./engine.js";

/** The hidden host window (C9): keeps the engine running and receives `herdr-app do herdr-caffeinate.<command>`. */
export const HOST = Object.freeze({
  mod: MOD_ID,
  props: Object.freeze({ view: "host" }),
  kind: "window",
  frame: "none",
  key: `${MOD_ID}.host`,
  width: 2,
  height: 2,
  at: Object.freeze({ x: 0, y: 0 }),
});

/** The menu popover the `menu` command opens (views may replace it with `engine.setMenuOpener`). */
export const MENU = Object.freeze({ mod: MOD_ID, props: Object.freeze({ view: "menu" }), kind: "popup", at: "pointer" });

const HOST_REOPEN_MS = 3000;

export const engine = createEngine({
  exec,
  readTextFile,
  writeTextFile,
  mkdir: (path) => fs.mkdir(path, { recursive: true }),
  terminals,
  setShared,
  notify,
  runCommand: run,
  checking,
  appHome,
  home,
  now: () => Date.now(),
  log: (message) => console.log(message),
  openMenu: () => openOverlay({ ...MENU, props: { ...MENU.props } }),
});

let hostOpenedAt = -Infinity;

/** Opens the host window when no host copy is attached (chip and menu copies, C11), at most once per 3 s. Returns
 *  the overlay id, or null when it did not open one. */
export function ensureHost() {
  if (checking() || !engine.needsHost()) return null;
  const now = Date.now();
  if (now - hostOpenedAt < HOST_REOPEN_MS) return null;
  hostOpenedAt = now;
  return openOverlay({ ...HOST, props: { ...HOST.props }, at: { ...HOST.at } });
}
