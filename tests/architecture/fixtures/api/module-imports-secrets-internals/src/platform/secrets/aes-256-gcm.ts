export function seal(key: string, value: string): string {
  return `${key}:${value}`;
}
