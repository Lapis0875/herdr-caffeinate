// The engine's files under `<app home>/data/herdr-caffeinate/` (C2, C3): settings.json, runtime.json and
// state.json, each written with `writeTextFile(path, text, expected)` against the text last read or written, so an
// edit made outside Herdr is never overwritten unseen. Unknown settings fields are kept (core/state.js).

import {
  dataDir, defaultSettings, normalizeRuntime, parseSettings, runtimePath, serializeSettings, settingsPath, statePath,
} from "../core/state.js";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * deps: `readTextFile(path)` → text or null when absent; `writeTextFile(path, text, expected)` rejects on a stale
 * `expected`; `mkdir(path)` creates the folder and its parents. Every method rethrows what `guard(error)` returns
 * true for (the engine's "this run stopped" signal), and reports other failures through its result.
 */
export class Store {
  constructor(deps, appHome, guard = () => false) {
    this.deps = deps;
    this.guard = guard;
    this.paths = { dir: dataDir(appHome), settings: settingsPath(appHome), runtime: runtimePath(appHome), state: statePath(appHome) };
    // The text each file had when last read or written: undefined before the first read, null when absent.
    this.text = { settings: undefined, runtime: undefined, state: undefined };
    this.settings = defaultSettings();
    // False while settings.json holds text that is not a JSON object: in use are the last good settings (the
    // defaults at first), and nothing is written over the owner's file.
    this.settingsOk = true;
  }

  async read(name) {
    try {
      const text = await this.deps.readTextFile(this.paths[name]);
      return typeof text === "string" ? text : null;
    } catch (e) {
      if (this.guard(e)) throw e;
      return null;
    }
  }

  /** Writes `text` over the last known text; on a stale snapshot re-reads once and writes over that (runtime and
   *  state belong to the engine alone). Returns whether it was written. */
  async put(name, text, { retry = true } = {}) {
    if (this.text[name] === text) return true;
    try {
      await this.deps.writeTextFile(this.paths[name], text, this.text[name] ?? null);
      this.text[name] = text;
      return true;
    } catch (e) {
      if (this.guard(e)) throw e;
      if (!retry) return false;
      this.text[name] = await this.read(name);
      return this.put(name, text, { retry: false });
    }
  }

  /** Creates the data folder. */
  async ensureDir() {
    try {
      await this.deps.mkdir(this.paths.dir);
      return true;
    } catch (e) {
      if (this.guard(e)) throw e;
      return false;
    }
  }

  /**
   * Reads settings.json and applies it when its text differs from the last text read (or `force`). An absent file
   * is created with the defaults. Returns `{changed, settings, ok}`: `ok` false when the text is not a JSON object
   * (the last good settings stay in use).
   */
  async loadSettings(force = false) {
    const text = await this.read("settings");
    if (text === null) {
      const defaults = defaultSettings();
      const changed = this.text.settings !== null || serializeSettings(this.settings) !== serializeSettings(defaults);
      this.text.settings = null;
      this.settings = defaults;
      this.settingsOk = true;
      await this.put("settings", serializeSettings(defaults), { retry: false });
      return { changed, settings: this.settings, ok: true };
    }
    if (!force && text === this.text.settings) return { changed: false, settings: this.settings, ok: this.settingsOk };
    this.text.settings = text;
    const parsed = parseSettings(text);
    this.settingsOk = parsed.ok;
    if (parsed.ok) this.settings = parsed.settings;
    return { changed: true, settings: this.settings, ok: parsed.ok };
  }

  /** Writes `settings` over the last text read (never over a file that is not a JSON object) and uses them.
   *  Returns false on a stale snapshot or a failed write; the caller re-reads and decides again. */
  async saveSettings(settings) {
    if (!this.settingsOk) return false;
    const ok = await this.put("settings", serializeSettings(settings), { retry: false });
    if (ok) this.settings = settings;
    return ok;
  }

  /** runtime.json, normalized (anything invalid reads as nothing recorded). */
  async loadRuntime() {
    const text = await this.read("runtime");
    this.text.runtime = text;
    let raw = null;
    try {
      raw = text === null ? null : JSON.parse(text);
    } catch {
      raw = null;
    }
    return normalizeRuntime(raw);
  }

  /** Writes runtime.json when its text changes. */
  saveRuntime(runtime) {
    return this.put("runtime", json(runtime));
  }

  /** Reads state.json's text, so the next publish writes over it. */
  async loadState() {
    this.text.state = await this.read("state");
  }

  /** Writes state.json (the published C3 object). */
  saveState(shared) {
    return this.put("state", json(shared));
  }
}
