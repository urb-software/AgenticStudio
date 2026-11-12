/** Longest allowed project name, counted after normalization. */
export const PROJECT_NAME_MAX_LENGTH = 100;

/**
 * Trims the name and collapses every internal whitespace run to one space. Case is
 * kept. Idempotent, so a name normalized at the HTTP edge can be normalized again.
 */
export function normalizeProjectName(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ');
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
 * A valid project name (Story #16 clarification 1): `value` is the normalized display
 * name, 1–100 characters; `uniquenessKey` is `value` lower-cased (Unicode-aware) and is
 * what makes two names the same project name.
 */
export class ProjectName {
  private constructor(
    readonly value: string,
    readonly uniquenessKey: string,
  ) {}

  static parse(raw: string): ProjectName {
    const value = normalizeProjectName(raw);
    if (value.length === 0) {
      throw new InvalidProjectNameError('empty');
    }
    if (value.length > PROJECT_NAME_MAX_LENGTH) {
      throw new InvalidProjectNameError('too-long');
    }
    return new ProjectName(value, value.toLowerCase());
  }
}
