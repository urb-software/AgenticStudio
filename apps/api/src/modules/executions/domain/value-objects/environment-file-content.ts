import { KNOWN_SECRET_MIN_LENGTH } from './log-redaction.js';

const LOOSE_LINE_MIN_LENGTH = 8;

const PAIR = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=(.*)$/;

const QUOTES = new Set(['"', "'", '`']);

/** Best effort, like all redaction (security.md §3): the file holds test values only. */
export class EnvironmentFileContent {
  private constructor(private readonly content: string) {}

  static of(content: string): EnvironmentFileContent {
    return new EnvironmentFileContent(content);
  }

  valuesToRedact(): string[] {
    const values = new Set<string>();
    for (const rawLine of this.content.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      const commented = line.startsWith('#');
      const pair = PAIR.exec(commented ? line.slice(1).trim() : line);
      if (pair) {
        for (const value of EnvironmentFileContent.valuesOf(pair[1]!)) {
          if (value.length >= KNOWN_SECRET_MIN_LENGTH) values.add(value);
        }
      } else if (!commented && line.length >= LOOSE_LINE_MIN_LENGTH) {
        values.add(line);
      }
    }
    return [...values];
  }

  private static valuesOf(raw: string): string[] {
    const value = raw.trim();
    if (value.length >= 2 && QUOTES.has(value[0]!) && value.at(-1) === value[0]) {
      return [value.slice(1, -1)];
    }
    const comment = value.indexOf(' #');
    return comment === -1 ? [value] : [value, value.slice(0, comment).trim()];
  }
}
