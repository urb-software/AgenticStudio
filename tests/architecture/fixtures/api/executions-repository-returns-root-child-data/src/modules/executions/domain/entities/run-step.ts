import type { RunStepData } from './run-step-data.js';

export class RunStep {
  private constructor(readonly index: number) {}

  static create(index: number): RunStep {
    return new RunStep(index);
  }

  static restore(data: RunStepData): RunStep {
    return new RunStep(data.index);
  }
}
