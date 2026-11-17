export type RunId = string;

export type RunSnapshot = { readonly id: string; readonly state: string };

export class RunNotFoundError extends Error {}

export class Run {
  private constructor(
    readonly id: string,
    readonly state: string,
  ) {}

  static restore(id: string, state: string): Run {
    return new Run(id, state);
  }

  snapshot(): RunSnapshot {
    return { id: this.id, state: this.state };
  }
}
