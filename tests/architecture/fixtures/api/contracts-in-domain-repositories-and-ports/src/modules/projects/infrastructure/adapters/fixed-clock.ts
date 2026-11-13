import { SystemClock } from './system-clock.js';

// Extending a concrete adapter is not implementing a contract.
export class FixedClock extends SystemClock {
  override now(): Date {
    return new Date(0);
  }
}
