// Language-neutral number formats for the chip and the menu (digits and colons only, no unit words, so ko and en
// share them). Pure: callers pass `now`.

const pad2 = (n) => String(n).padStart(2, "0");

/** Milliseconds left until `endsAt` at `now`, never below 0; null when either is not a finite number. */
export function remainingMs(endsAt, now) {
  if (!Number.isFinite(endsAt) || !Number.isFinite(now)) return null;
  return Math.max(0, endsAt - now);
}

/** A countdown label for `ms` milliseconds left: under one hour `m:ss` ("1:59", "0:05", "1:00" is one minute), from
 *  one hour `h:mm:ss` ("1:00:00", "24:00:00"), so a minute and an hour never read the same. Rounds up like a countdown,
 *  so it reads "0:00" only when nothing is left and never shows a longer time than was set. Negative values count as
 *  0; a non-finite value gives "". */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms)) return "";
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${pad2(seconds % 60)}`;
  return `${Math.floor(seconds / 3600)}:${pad2(Math.floor(seconds / 60) % 60)}:${pad2(seconds % 60)}`;
}

/** The countdown label for a session ending at `endsAt`, or "" when there is no end time. */
export function formatUntil(endsAt, now) {
  const ms = remainingMs(endsAt, now);
  return ms === null ? "" : formatRemaining(ms);
}
