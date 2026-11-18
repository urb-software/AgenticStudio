import { InvalidTaskError } from '../errors/run-errors.js';

/** In UTF-16 code units, as the request schema counts them. */
export const TASK_MAX_LENGTH = 20_000;

/** The request schema repeats the limit only to report it as a field error. */
export class Task {
  private constructor(readonly value: string) {}

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
