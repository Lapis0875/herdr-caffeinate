// Agent count for Agent mode (C11): `terminals()` entries with `status === "working"` and `state === "live"`, local
// only (an address without a `machine/` prefix) unless `agent.includeRemote`.

/** How many agents work now in `terminals` (the herdr `terminals()` list). */
export function workingAgents(terminals, includeRemote = false) {
  if (!Array.isArray(terminals)) return 0;
  let count = 0;
  for (const t of terminals) {
    if (!t || t.status !== "working" || t.state !== "live") continue;
    if (!includeRemote && !(typeof t.address === "string" && !t.address.includes("/"))) continue;
    count += 1;
  }
  return count;
}
