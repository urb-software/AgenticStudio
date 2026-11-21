import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/** The Merge credential: prints as redacted in a log, a JSON dump or an error. */
export class MergeCredential {
  static readonly MIN_LENGTH = 20;
  static readonly MAX_LENGTH = 255;

  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static isWellFormed(value: string): boolean {
    return (
      value.length >= MergeCredential.MIN_LENGTH &&
      value.length <= MergeCredential.MAX_LENGTH &&
      !/\s/.test(value)
    );
  }

  static of(value: string): MergeCredential {
    if (!MergeCredential.isWellFormed(value)) throw new Error('Malformed Merge credential.');
    return new MergeCredential(value);
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
