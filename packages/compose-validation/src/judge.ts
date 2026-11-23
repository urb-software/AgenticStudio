import { REFUSAL_MESSAGES, type Refusal, type RefusalCode } from './refusal.js';
import type { Path } from './parse.js';

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // A `Set` or a `Map` from a YAML tag is not a mapping, whatever its entries.
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isScalarValue(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

export function isScalarMap(value: unknown): boolean {
  return isObj(value) && Object.values(value).every((item) => item === null || isScalarValue(item));
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isScalarList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isScalarValue);
}

/** True when a string, or a key, anywhere in the value holds a `$` (an interpolation). */
export function hasDollar(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('$');
  if (Array.isArray(value)) return value.some(hasDollar);
  if (isObj(value)) {
    return Object.entries(value).some(([key, item]) => key.includes('$') || hasDollar(item));
  }
  return false;
}

/** Writes `services.web.volumes[1]`; a name with unusual characters is written as `["name"]`. */
export function placeOf(path: Path): string {
  let place = '';
  for (const part of path) {
    if (typeof part === 'number') place += `[${part}]`;
    else if (/^[A-Za-z0-9_-]+$/.test(part)) place += place === '' ? part : `.${part}`;
    else place += `[${JSON.stringify(part.slice(0, 64))}]`;
  }
  return place === '' ? '(document)' : place;
}

/** Collects refusals. Messages are fixed per code and never carry a value from the file. */
export class Judge {
  readonly refusals: Refusal[] = [];
  /** A hostile file can hold thousands of problems; the first ones are enough to act on. */
  static readonly MAX_REFUSALS = 100;

  constructor(private readonly lineOf: (path: Path) => number | undefined) {}

  refuse(code: RefusalCode, path: Path, line?: number | null): void {
    if (this.refusals.length >= Judge.MAX_REFUSALS) return;
    const found = line === null ? undefined : (line ?? this.lineOf(path));
    const refusal: Refusal = { code, place: placeOf(path), message: REFUSAL_MESSAGES[code] };
    if (found !== undefined) refusal.line = found;
    this.refusals.push(refusal);
  }

  /** Refuses every key not in the list. */
  onlyKeys(obj: Obj, allowed: ReadonlySet<string>, path: Path): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) this.refuse('unknown_key', [...path, key]);
    }
  }

  /** Refuses with `interpolation` when the value holds a `$`; the caller then skips the field. */
  interpolated(value: unknown, path: Path): boolean {
    if (!hasDollar(value)) return false;
    this.refuse('interpolation', path);
    return true;
  }
}
