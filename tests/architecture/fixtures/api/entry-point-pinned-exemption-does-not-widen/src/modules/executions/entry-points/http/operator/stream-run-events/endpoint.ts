import { CLOCK, type Clock } from '../../../../application/ports/clock.js';

export class StreamRunEventsEndpoint {
  constructor(private readonly clock: Clock) {}

  token(): symbol {
    return CLOCK;
  }

  now(): number {
    return this.clock.now();
  }
}
