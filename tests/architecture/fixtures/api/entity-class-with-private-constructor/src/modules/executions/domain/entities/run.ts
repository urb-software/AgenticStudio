import { RunNotWaitingError } from '../errors/run-errors.js';

export class Run {
  private constructor(readonly state: string) {}

  static start(): Run {
    return new Run('queued');
  }

  static restore(state: string): Run {
    return new Run(state);
  }

  answer(): void {
    if (this.state !== 'waiting') throw new RunNotWaitingError(this.state);
  }
}
