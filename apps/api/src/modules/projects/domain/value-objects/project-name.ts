export const PROJECT_NAME_MIN_LENGTH = 1;
export const PROJECT_NAME_MAX_LENGTH = 100;

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
 * A valid project name: `value` is the normalized display name (NFC, trimmed, whitespace collapsed),
 * 1–100 code points; `uniquenessKey` is `value` lower-cased and decides which names are the same.
 */
export class ProjectName {
  private constructor(
    readonly value: string,
    readonly uniquenessKey: string,
  ) {}

  /**
   * Normalizes to NFC first (so NFC and NFD spellings are one name), then trims and collapses
   * whitespace runs to one space. Case is kept. Idempotent, so it can run again after the HTTP edge.
   */
  static normalize(raw: string): string {
    return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
  }

  static parse(raw: string): ProjectName {
    const value = ProjectName.normalize(raw);
    const length = ProjectName.codePointLength(value);
    if (length < PROJECT_NAME_MIN_LENGTH) {
      throw new InvalidProjectNameError('empty');
    }
    if (length > PROJECT_NAME_MAX_LENGTH) {
      throw new InvalidProjectNameError('too-long');
    }
    return new ProjectName(value, value.toLowerCase().normalize('NFC'));
  }

  /**
   * Length in code points, the unit PostgreSQL `char_length` uses: an emoji outside the BMP counts as 1.
   */
  private static codePointLength(value: string): number {
    return Array.from(value).length;
  }
}
