/** Holds a counter; one sentence is enough. */
export class Counter {
  // The lock makes read-check-write atomic: two callers must not both pass the check.
  // A second line is still within the limit.
  // A third line too.
  increment(value: number): number {
    return value + 1; // a trailing comment is not part of a run
  }
}

/**
 *
 * A block of three text lines, with blank
 * lines around them that do not count.
 * The third line.
 *
 */
export const three = 3;

// eslint-disable-next-line no-console
// @ts-expect-error the directive lines are not comments for rule 14
// prettier-ignore
export const directives = 1 as string;
