// Parsers for bin/probe.sh output (docs/CONTRACTS.md C5) and for `sysctl kern.waketime` (S4).
// Pure: no imports, no clock. Unreadable input yields null facts; nothing here throws.

const POWER = new Map([['AC Power', true], ['Battery Power', false], ['UPS Power', false]]);
const YES_NO = new Map([['Yes', true], ['No', false]]);
const STAMP = /^\d{1,12}$/;

/**
 * parseProbe(text) → facts of one `bin/probe.sh [--thermal]` run. Each field is null when its
 * section or line is missing or lacks the documented form.
 * - ac: "Now drawing from 'AC Power'" → true; 'Battery Power' or 'UPS Power' → false.
 * - percent: the first `<n>%;` of `pmset -g batt` (the internal battery), 0..100.
 * - sleepDisabled: `SleepDisabled 1` → true, `0` → false.
 * - lidClosed / lidCausesSleep: "AppleClamshellState" / "AppleClamshellCausesSleep" = Yes → true,
 *   No → false, matched by key in any order.
 * - thermal: NSProcessInfoThermalState (0 nominal, 1 fair, 2 serious, 3 critical); null without --thermal.
 * - failsafeAliveAge / claimAge: seconds, now − mtime of `alive` / `claim`. Negative when the mtime is
 *   ahead of the wall clock (clock set back); a negative age is not a fresh file.
 * - lastRestore: epoch seconds of the watchdog's last restore (mtime of `last-restore`).
 * - now: epoch seconds when the probe ran (seconds, not milliseconds).
 */
export function parseProbe(text) {
  const facts = {
    ac: null, percent: null, sleepDisabled: null, lidClosed: null, lidCausesSleep: null,
    thermal: null, failsafeAliveAge: null, claimAge: null, lastRestore: null, now: null,
  };
  if (typeof text !== 'string') return facts;
  const found = sections(text);

  const batt = found.get('batt') ?? [];
  facts.ac = first(batt, (line) => {
    const m = /^\s*Now drawing from '([^']*)'/.exec(line);
    return m ? POWER.get(m[1]) ?? null : undefined;
  });
  facts.percent = first(batt, (line) => {
    const m = /(?<![\d.])(\d{1,3})%;/.exec(line);
    if (!m) return undefined;
    const value = Number(m[1]);
    return value <= 100 ? value : null;
  });

  facts.sleepDisabled = first(found.get('pmset') ?? [], (line) => {
    const m = /^\s*SleepDisabled\s+(\S+)\s*$/.exec(line);
    if (!m) return undefined;
    return m[1] === '1' ? true : m[1] === '0' ? false : null;
  });

  const lid = found.get('lid') ?? [];
  facts.lidClosed = clamshell(lid, 'AppleClamshellState');
  facts.lidCausesSleep = clamshell(lid, 'AppleClamshellCausesSleep');

  const thermal = (found.get('thermal') ?? []).join('\n').trim();
  if (/^\d{1,2}$/.test(thermal)) facts.thermal = Number(thermal);

  const stamps = new Map();
  for (const line of found.get('stat') ?? []) {
    const m = /^(alive|claim|restore|now)=(.*)$/.exec(line);
    if (!m || stamps.has(m[1])) continue;
    const value = m[2].trim();
    stamps.set(m[1], STAMP.test(value) ? Number(value) : null);
  }
  const now = stamps.get('now') ?? null;
  const age = (key) => {
    const mtime = stamps.get(key) ?? null;
    return now === null || mtime === null ? null : now - mtime;
  };
  facts.failsafeAliveAge = age('alive');
  facts.claimAge = age('claim');
  facts.lastRestore = stamps.get('restore') ?? null;
  facts.now = now;
  return facts;
}

/**
 * parseWaketime(text) → epoch seconds of the last wake, from `sysctl -n kern.waketime`
 * (`{ sec = 1795094890, usec = 792285 } Thu Nov 19 22:28:10 2026`) or the `kern.waketime: …`
 * line of `sysctl kern.waketime …`. Null when unreadable or 0 (no wake recorded).
 */
export function parseWaketime(text) {
  if (typeof text !== 'string') return null;
  const m = /^[ \t]*(?:kern\.waketime:[ \t]*)?\{ *sec *= *(\d{1,12}) *, *usec *= *\d{1,9} *\}/m.exec(text);
  if (!m) return null;
  const sec = Number(m[1]);
  return sec > 0 ? sec : null;
}

/**
 * secondsSinceWake(waketime, now) → now − waketime (both epoch seconds), or null when either is
 * unknown or the result is negative (clock set back). The C7 wake grace applies only when the
 * result is non-null and below the grace (S4: 0 ≤ now − waketime < 60), so an unknown or negative
 * value never grants it.
 */
export function secondsSinceWake(waketime, now) {
  if (!Number.isSafeInteger(waketime) || waketime <= 0 || !Number.isFinite(now)) return null;
  const since = now - waketime;
  return since >= 0 ? since : null;
}

// Lines under each `@@name` header; a repeated header's lines are ignored.
function sections(text) {
  const found = new Map();
  let lines = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^@@([a-z]+)\s*$/.exec(line);
    if (header) {
      lines = found.has(header[1]) ? null : [];
      if (lines) found.set(header[1], lines);
    } else if (lines) {
      lines.push(line);
    }
  }
  return found;
}

// Result of the first line `read` recognises (returns non-undefined), or null.
function first(lines, read) {
  for (const line of lines) {
    const value = read(line);
    if (value !== undefined) return value;
  }
  return null;
}

function clamshell(lines, key) {
  return first(lines, (line) => {
    const m = /^\s*"(\w+)"\s*=\s*(\S+)\s*$/.exec(line);
    if (!m || m[1] !== key) return undefined;
    return YES_NO.get(m[2]) ?? null;
  });
}
