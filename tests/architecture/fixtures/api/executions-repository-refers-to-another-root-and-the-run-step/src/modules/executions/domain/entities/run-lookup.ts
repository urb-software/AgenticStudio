export class RunLookup {
  private constructor(readonly id: string) {}

  static restore(id: string): RunLookup {
    return new RunLookup(id);
  }
}
