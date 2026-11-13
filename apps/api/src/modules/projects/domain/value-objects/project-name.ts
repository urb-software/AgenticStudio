/** Shortest and longest allowed project name, in code points, counted after normalization. */
export const PROJECT_NAME_MIN_LENGTH = 1;
export const PROJECT_NAME_MAX_LENGTH = 100;

/**
 * Normalizes to Unicode NFC first (so NFC and NFD spellings are the same name, Issue #30
 * decision 1), then trims and collapses every internal whitespace run to one space. Case
 * is kept. Idempotent, so a name normalized at the HTTP edge can be normalized again.
 */
export function normalizeProjectName(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/**
 * Length in Unicode code points, the unit PostgreSQL `char_length` and `VARCHAR(n)` use
 * (Issue #30 decision 2): an emoji outside the BMP counts as 1, not as 2 UTF-16 code units.
 */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Thrown when a name is empty or too long after normalization. */
export class InvalidProjectNameError extends Error {
  constructor(readonly reason: 'empty' | 'too-long') {
    super(
      reason === 'empty'
        ? 'A project name must not be empty.'
        : `A project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
    );
    this.name = 'InvalidProjectNameError';
  }
}

/**
 * A valid project name (Story #16 clarification 1, Issue #30 decisions 1–2): `value` is the
 * normalized (NFC, trimmed, whitespace-collapsed) display name, 1–100 code points;
 * `uniquenessKey` is `value` lower-cased (Unicode-aware, re-normalized to NFC) and is what
 * makes two names the same project name.
 */
export class ProjectName {
  private constructor(
    readonly value: string,
    readonly uniquenessKey: string,
  ) {}

  static parse(raw: string): ProjectName {
    const value = normalizeProjectName(raw);
    const length = codePointLength(value);
    if (length < PROJECT_NAME_MIN_LENGTH) {
      throw new InvalidProjectNameError('empty');
    }
    if (length > PROJECT_NAME_MAX_LENGTH) {
      throw new InvalidProjectNameError('too-long');
    }
    return new ProjectName(value, value.toLowerCase().normalize('NFC'));
  }
}
