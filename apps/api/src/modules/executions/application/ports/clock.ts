export const CLOCK = Symbol('CLOCK');

/** Tests pass a controlled clock (`ExecutionsModuleOptions`). */
export interface Clock {
  now(): Date;
}
