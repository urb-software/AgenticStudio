const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/**
 * A byte count in binary units ("3.2 GiB"), one decimal below 10 and none above, as the agent
 * worker's disk figures read; the worker's threshold is configured in GiB.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const text = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${text.replace(/\.0$/, '')} ${UNITS[unit]}`;
}
