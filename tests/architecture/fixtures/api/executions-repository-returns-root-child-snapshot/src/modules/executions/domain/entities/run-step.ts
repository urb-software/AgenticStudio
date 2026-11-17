import type { RunStepSnapshot } from '../value-objects/run-step-snapshot.js';

export class RunStep {
  private constructor(readonly index: number) {}

  static create(index: number): RunStep {
    return new RunStep(index);
  }

  snapshot(): RunStepSnapshot {
    return { index: this.index };
  }
}
