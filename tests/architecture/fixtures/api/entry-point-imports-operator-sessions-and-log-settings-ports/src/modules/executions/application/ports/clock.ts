export const CLOCK = Symbol('CLOCK');

export class ClockUnavailableError extends Error {}

export interface Clock {
  now(): number;
}
