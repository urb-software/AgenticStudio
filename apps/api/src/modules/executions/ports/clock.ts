/** DI token of the {@link Clock}. */
export const CLOCK = Symbol('CLOCK');

/**
 * The time the `executions` module works with (claims, heartbeats, the lost-worker sweep).
 * Production uses the system clock; tests pass a controlled one (`ExecutionsModuleOptions`).
 */
export interface Clock {
  now(): Date;
}
