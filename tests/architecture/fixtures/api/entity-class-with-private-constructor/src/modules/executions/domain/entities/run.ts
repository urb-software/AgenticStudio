export class RunNotWaitingError extends Error {
  constructor(readonly state: string) {
    super('The run is not waiting for an answer.');
  }
}

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
