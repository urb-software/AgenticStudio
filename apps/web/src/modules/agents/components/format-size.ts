/** A file size in bytes: "812 B", "3.4 KiB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${text.replace(/\.0$/, '')} ${units[unit]}`;
}
