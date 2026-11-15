import { KNOWN_SECRET_MIN_LENGTH } from './log-redaction.js';

/** Lines that are not `KEY=VALUE` are redacted whole from this length (Issue #104). */
const LOOSE_LINE_MIN_LENGTH = 8;

/** `KEY=VALUE`, optionally after `export`; the key as dotenv files write it. */
const PAIR = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=(.*)$/;

const QUOTES = new Set(['"', "'", '`']);

/** The value without its surrounding quotes, and without a trailing comment when unquoted. */
function valuesOf(raw: string): string[] {
  const value = raw.trim();
  if (value.length >= 2 && QUOTES.has(value[0]!) && value.at(-1) === value[0]) {
    return [value.slice(1, -1)];
  }
  const comment = value.indexOf(' #');
  return comment === -1 ? [value] : [value, value.slice(0, comment).trim()];
}

/**
 * The values of a Run's Environment file that log redaction replaces (Issue #104, coordinator
 * decision), dotenv style: the value of every `KEY=VALUE` line (optional `export`, quotes
 * stripped, a trailing ` # comment` of an unquoted value also cut off), including a pair that
 * is commented out; every other line that is not a comment, whole, from 8 characters. Values
 * shorter than 4 characters are left out (they would wreck the log). Each value once, in file
 * order. Best effort, like all redaction (security.md §3): the file holds test values only.
 */
export function environmentFileValues(content: string): string[] {
  const values = new Set<string>();
  for (const rawLine of content.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const commented = line.startsWith('#');
    const pair = PAIR.exec(commented ? line.slice(1).trim() : line);
    if (pair) {
      for (const value of valuesOf(pair[1]!)) {
        if (value.length >= KNOWN_SECRET_MIN_LENGTH) values.add(value);
      }
    } else if (!commented && line.length >= LOOSE_LINE_MIN_LENGTH) {
      values.add(line);
    }
  }
  return [...values];
}
