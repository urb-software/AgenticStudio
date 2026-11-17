export class RunStep {
  private constructor(readonly index: number) {}

  static create(index: number): RunStep {
    return new RunStep(index);
  }
}
