/** Render an epoch-ms timestamp as a compact relative string for chat
 * bubbles. Stages match human attention:
 *
 *   < 5s              → "just now"
 *   < 60s             → "Ns ago"
 *   < 60min           → "Nm ago"
 *   same calendar day → "at HH:MM"
 *   otherwise         → "YYYY-MM-DD HH:MM"
 *
 * Hover tooltips elsewhere use the full ISO string via `formatIso()`. */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.round((now - ms) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const d = new Date(ms);
  const nowD = new Date(now);
  const sameDay =
    d.getFullYear() === nowD.getFullYear() &&
    d.getMonth() === nowD.getMonth() &&
    d.getDate() === nowD.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `at ${hh}:${mm}`;
  const yy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mo}-${dd} ${hh}:${mm}`;
}

/** Full ISO 8601 for the hover tooltip. */
export function formatIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Composite hover-tooltip text for an item that may have both a
 * createdAt and an updatedAt (streaming assistant / thought / tasks
 * snapshots). Falls back to just createdAt when no update has
 * happened. */
export function formatHover(createdAt: number, updatedAt?: number): string {
  const c = formatIso(createdAt);
  if (updatedAt == null || updatedAt === createdAt) return c;
  return `${c}\nlast update: ${formatIso(updatedAt)}`;
}
