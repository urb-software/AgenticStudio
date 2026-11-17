/** Longest Task, in characters (UTF-16 code units, as the request schema counts them). */
export const TASK_MAX_LENGTH = 20_000;

/** A Task the Run cannot be started with: empty after trimming, or longer than the limit. */
export class InvalidTaskError extends Error {
  constructor(readonly reason: 'empty' | 'too_long') {
    super(reason === 'empty' ? 'Enter a task.' : `Use at most ${TASK_MAX_LENGTH} characters.`);
    this.name = 'InvalidTaskError';
  }
}

/**
 * The Task of a Run (Issue #96): what the operator asked the agent to do. Trimmed, not empty and
 * at most {@link TASK_MAX_LENGTH} characters, so every entry point that starts a Run holds to the
 * same rule; the request schema repeats the limit only to report it as a field error.
 */
export class Task {
  private constructor(readonly value: string) {}

  /** Throws {@link InvalidTaskError} unless `text`, trimmed, is 1 to {@link TASK_MAX_LENGTH} characters. */
  static of(text: string): Task {
    const value = text.trim();
    if (value.length === 0) throw new InvalidTaskError('empty');
    if (value.length > TASK_MAX_LENGTH) throw new InvalidTaskError('too_long');
    return new Task(value);
  }

  toString(): string {
    return this.value;
  }
}
