/**
 * A duration in the design system's style (`4m 12s`): seconds under a minute, minutes and
 * seconds under an hour, hours and minutes beyond. A negative span (clock skew) is `0s`.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
