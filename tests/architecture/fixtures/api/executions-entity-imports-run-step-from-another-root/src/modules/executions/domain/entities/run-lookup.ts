import { RunStep } from './run-step.js';

export class RunLookup {
  private constructor(readonly step: RunStep) {}

  static restore(step: RunStep): RunLookup {
    return new RunLookup(step);
  }
}
