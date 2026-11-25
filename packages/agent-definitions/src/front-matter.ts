import { isMap, parseDocument } from 'yaml';
import { MAX_FRONT_MATTER_BYTES } from './limits.js';

export type FrontMatter =
  | { status: 'ok'; values: Record<string, unknown>; instructions: string }
  | { status: 'missing' | 'malformed' | 'too_large' };

/** The UTF-8 length of a string, without any encoder, so the package runs anywhere. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/;

/**
 * Splits an entry file into its front matter (a YAML mapping) and its instructions. The YAML is
 * read with the core schema and refuses duplicate keys, aliases, custom tags and any non-text key.
 */
export function parseEntry(text: string): FrontMatter {
  const opening = OPENING.exec(text);
  if (!opening) return { status: 'missing' };
  const rest = text.slice(opening[0].length);
  const closing = CLOSING.exec(rest);
  if (!closing) return { status: 'missing' };
  const front = rest.slice(0, closing.index);
  const instructions = rest.slice(closing.index + closing[0].length);
  if (utf8Length(front) > MAX_FRONT_MATTER_BYTES) return { status: 'too_large' };

  const document = parseDocument(front, { schema: 'core', version: '1.2', uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) return { status: 'malformed' };
  if (document.contents === null) return { status: 'ok', values: {}, instructions };
  if (!isMap(document.contents)) return { status: 'malformed' };

  // A key that is not text (for example `1:`) is read as a number or boolean, never a name.
  for (const item of document.contents.items) {
    const key = item.key as { value?: unknown } | null;
    if (typeof key?.value !== 'string') return { status: 'malformed' };
  }
  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    return { status: 'malformed' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'malformed' };
  }
  return { status: 'ok', values: parsed as Record<string, unknown>, instructions };
}
