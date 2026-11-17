export class Run {
  private constructor(readonly state: string) {}

  static start(): Run {
    return new Run('queued');
  }

  static restore(state: string): Run {
    return new Run(state);
  }
}
