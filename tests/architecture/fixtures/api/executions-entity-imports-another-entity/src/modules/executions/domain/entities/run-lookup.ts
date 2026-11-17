import { Run } from './run.js';

export class RunLookup {
  private constructor(readonly run: Run) {}

  static restore(run: Run): RunLookup {
    return new RunLookup(run);
  }
}
