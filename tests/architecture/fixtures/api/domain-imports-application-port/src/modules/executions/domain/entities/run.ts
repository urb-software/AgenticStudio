import type { Clock } from '../../application/ports/clock.js';

export class Run {
  private constructor(readonly startedAt: Date) {}

  static start(clock: Clock): Run {
    return new Run(clock.now());
  }
}
