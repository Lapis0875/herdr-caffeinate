// The UI text catalogs: one fragment per area and language (`<area>.en.js`, `<area>.ko.js`), merged
// into one flat table per language. Rules for a fragment: `export default { "<area>.<name>": "text" }`;
// every key starts with its area; text is never empty; placeholders are `{name}` and the same in both
// languages. Product and program names stay English in both (Herdr, Mac, caffeinate, pmset, sudo).
// Keys that end in a C3 value (`mode.<mode>`, `lid.status.<status>`, `lid.block.<reason>`) cover
// every value the contract allows, so views can build them from the shared state.

import modeEn from "./mode.en.js";
import modeKo from "./mode.ko.js";
import timerEn from "./timer.en.js";
import timerKo from "./timer.ko.js";
import chipEn from "./chip.en.js";
import chipKo from "./chip.ko.js";
import menuEn from "./menu.en.js";
import menuKo from "./menu.ko.js";
import lidEn from "./lid.en.js";
import lidKo from "./lid.ko.js";
import installEn from "./install.en.js";
import installKo from "./install.ko.js";
import toastEn from "./toast.en.js";
import toastKo from "./toast.ko.js";
import errorEn from "./error.en.js";
import errorKo from "./error.ko.js";

/** The areas, one fragment pair each. */
export const AREAS = Object.freeze(["mode", "timer", "chip", "menu", "lid", "install", "toast", "error"]);

/** Every fragment by area, then language. */
export const fragments = Object.freeze({
  mode: { en: modeEn, ko: modeKo },
  timer: { en: timerEn, ko: timerKo },
  chip: { en: chipEn, ko: chipKo },
  menu: { en: menuEn, ko: menuKo },
  lid: { en: lidEn, ko: lidKo },
  install: { en: installEn, ko: installKo },
  toast: { en: toastEn, ko: toastKo },
  error: { en: errorEn, ko: errorKo },
});

function merge(lang) {
  const table = {};
  for (const area of AREAS) Object.assign(table, fragments[area][lang]);
  return Object.freeze(table);
}

/** One flat table per language: `catalogs.en["mode.off"]`. */
export const catalogs = Object.freeze({ en: merge("en"), ko: merge("ko") });
