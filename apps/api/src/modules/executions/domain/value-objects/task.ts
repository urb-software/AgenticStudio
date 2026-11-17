import { InvalidTaskError } from './run-errors.js';

/** Longest Task, in characters (UTF-16 code units, as the request schema counts them). */
export const TASK_MAX_LENGTH = 20_000;

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
    if (value.length === 0) throw new InvalidTaskError('empty', TASK_MAX_LENGTH);
    if (value.length > TASK_MAX_LENGTH) throw new InvalidTaskError('too_long', TASK_MAX_LENGTH);
    return new Task(value);
  }

  toString(): string {
    return this.value;
  }
}
