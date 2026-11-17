import { RunStep } from './run-step.js';

export class Run {
  private constructor(readonly steps: number) {}

  static restore(steps: number): Run {
    return new Run(steps);
  }

  takeStep(): RunStep {
    return RunStep.create(this.steps + 1);
  }
}
