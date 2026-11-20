/**
 * A strict reader for skill and agent frontmatter: scalars, flat lists and block scalars. Dropped
 * keys may hold anything; a kept key it cannot read invalidates the file. No YAML package, because
 * the worker's imports are deny-by-default.
 */

export type FrontmatterValue = string | number | boolean | null | string[];

export interface Frontmatter {
  /** Every top-level key in order; a value is `undefined` when it is not a readable scalar or list. */
  entries: [key: string, value: FrontmatterValue | undefined][];
  body: string;
}

export type FrontmatterResult = Frontmatter | { error: string };

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/;

function plainScalar(raw: string): FrontmatterValue {
  const text = raw.replace(/[ \t]+#.*$/, '').trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function quoted(text: string): string | undefined {
  if (text.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(text);
    if (!end) return undefined;
    try {
      const value: unknown = JSON.parse(end[0]);
      return typeof value === 'string' && /^\s*(#.*)?$/.test(text.slice(end[0].length))
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }
  const end = /^'(?:[^']|'')*'/.exec(text);
  if (!end || !/^\s*(#.*)?$/.test(text.slice(end[0].length))) return undefined;
  return end[0].slice(1, -1).replaceAll("''", "'");
}

function scalar(raw: string): FrontmatterValue | undefined {
  const text = raw.trim();
  if (text.startsWith('"') || text.startsWith("'")) return quoted(text);
  if (/^[[{&*!|>%@`]/.test(text) || /:(\s|$)/.test(text.replace(/\s+#.*$/, ''))) return undefined;
  return plainScalar(text);
}

/** `[a, "b", c]`, items split outside quotes; `undefined` when it is not a flat list. */
function flowList(raw: string): string[] | undefined {
  const match = /^\[(.*)\][ \t]*(?:#.*)?$/.exec(raw.trim());
  if (!match) return undefined;
  const inner = match[1]!.trim();
  if (inner === '') return [];
  const items: string[] = [];
  let rest = inner;
  while (rest !== '') {
    const quote = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(,|$)/.exec(rest);
    const plain = /^\s*([^,[\]{}"']*?)\s*(,|$)/.exec(rest);
    const found = quote ?? plain;
    if (!found) return undefined;
    const value = quote ? quoted(quote[1]!) : plainScalar(plain![1]!);
    if (value === undefined || value === null) return undefined;
    items.push(String(value));
    rest = rest.slice(found[0].length);
    if (found[2] === '' && rest !== '') return undefined;
  }
  return items;
}

/** The text of a `|` or `>` block scalar from its indented lines. */
function blockScalar(indicator: string, lines: string[]): string {
  const indent = Math.min(
    ...lines.filter((l) => l.trim() !== '').map((l) => /^[ \t]*/.exec(l)![0].length),
  );
  const text = lines.map((l) => l.slice(Math.min(indent, l.length)));
  while (text.length > 0 && text[text.length - 1]!.trim() === '') text.pop();
  const folded = indicator.startsWith('>')
    ? text
        .join('\n')
        .replace(/([^\n])\n(?=[^\n])/g, '$1 ')
        .replace(/\n\n/g, '\n')
    : text.join('\n');
  return indicator.includes('-') ? folded : folded + '\n';
}

function valueOf(inline: string, continuation: string[]): FrontmatterValue | undefined {
  const text = inline.trim();
  if (/^[|>][+-]?$/.test(text)) {
    return continuation.length === 0 ? '' : blockScalar(text, continuation);
  }
  if (text === '' || text.startsWith('#')) {
    const items = continuation.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (items.length === 0) return null;
    if (!items.every((l) => /^\s*-[ \t]+\S/.test(l))) return undefined;
    const values = items.map((l) => scalar(l.replace(/^\s*-[ \t]+/, '')));
    return values.every((v) => v !== undefined && v !== null)
      ? values.map((v) => String(v))
      : undefined;
  }
  if (text.startsWith('[')) return flowList(text);
  const first = scalar(text);
  if (first === undefined) return undefined;
  // A plain scalar may continue on further indented lines.
  const more = continuation.map((l) => l.trim()).filter((l) => l !== '');
  if (typeof first === 'string' && !text.startsWith('"') && !text.startsWith("'")) {
    return [first, ...more].join(' ');
  }
  return more.length === 0 ? first : undefined;
}

/** Splits a file into its frontmatter entries and body; no frontmatter means no entries. */
export function readFrontmatter(file: string): FrontmatterResult {
  const source = file.startsWith(String.fromCharCode(0xfeff)) ? file.slice(1) : file;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) {
    return /^---/.test(source)
      ? { error: 'unterminated frontmatter' }
      : { entries: [], body: source };
  }
  const lines = match[1]!.split(/\r?\n/);
  const entries: Frontmatter['entries'] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const key = KEY_LINE.exec(line);
    if (!key) {
      return {
        error:
          entries.length === 0 && /^-/.test(line)
            ? 'frontmatter is not a mapping'
            : 'invalid frontmatter',
      };
    }
    if (seen.has(key[1]!)) return { error: 'invalid frontmatter' };
    seen.add(key[1]!);
    const continuation: string[] = [];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      if (/^[ \t]/.test(next) || next.trim() === '' || /^-([ \t]|$)/.test(next)) {
        continuation.push(next);
        i += 1;
      } else break;
    }
    entries.push([key[1]!, valueOf(key[2] ?? '', continuation)]);
  }
  return { entries, body: source.slice(match[0].length) };
}

const PLAIN_SAFE = /^[A-Za-z][A-Za-z0-9 _.,/()-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n)$/i;

/** A value as one YAML line: plain when that reads back unchanged, else JSON. */
export function formatValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') {
    return PLAIN_SAFE.test(value) && !RESERVED.test(value.trim()) && value === value.trim()
      ? value
      : JSON.stringify(value);
  }
  return String(value);
}
