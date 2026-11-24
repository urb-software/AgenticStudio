export const CLOCK = Symbol('CLOCK');

/** Tests pass a controlled clock. */
export interface Clock {
  now(): Date;
}
