export function round(value: number): number;
export function round(value: string): string;
export function round(value: number | string): number | string {
  return typeof value === 'number' ? Math.round(value) : value.trim();
}
