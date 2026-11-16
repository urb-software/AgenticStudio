import {
  FAILING_CHECK_EXCERPT_MAX_LENGTH,
  FAILING_CHECK_EXCERPTS_TOTAL_MAX_LENGTH,
} from '@agentic-studio/contracts';

/** Lines of a job log kept for the operator (Issue #145), counted from the end. */
export const EXCERPT_LINES = 200;

/** A byte order mark some logs start with. */
const BOM = String.fromCharCode(0xfeff);

/** GitHub Actions starts each log line with a timestamp. */
const LINE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/** ANSI escape sequences (colours, cursor moves). */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/** Control characters other than the line break and the tab. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/**
 * The last lines of a job log as plain text for the operator's preview (Issue #145): the line
 * timestamps, colour codes and control characters removed, the last {@link EXCERPT_LINES} lines,
 * and at most `maxBytes` UTF-8 bytes of those (the end is kept: it is where a job says why it
 * failed). The text is untrusted; nothing here interprets it.
 */
export function logExcerpt(
  log: string,
  maxBytes = FAILING_CHECK_EXCERPT_MAX_LENGTH,
): string | undefined {
  const lines = log
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line.replace(BOM, '').replace(LINE_TIMESTAMP, '').replace(ANSI, '').replace(CONTROL, ''),
    );
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  if (lines.length === 0) return undefined;
  const excerpt = lines.slice(-EXCERPT_LINES).join('\n');
  return tailBytes(excerpt, maxBytes);
}

/** The end of `text`, at most `maxBytes` UTF-8 bytes, starting at a character boundary. */
export function tailBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  // Skip continuation bytes (10xxxxxx) so no character is split.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** What is left of the total allowance of excerpts after `used` bytes. */
export function excerptAllowance(used: number): number {
  return Math.min(
    FAILING_CHECK_EXCERPT_MAX_LENGTH,
    Math.max(0, FAILING_CHECK_EXCERPTS_TOTAL_MAX_LENGTH - used),
  );
}
