export type RunId = string;

export type RunView = { readonly id: string; readonly state: string };

export class Run {
  private constructor(
    readonly id: string,
    readonly state: string,
  ) {}

  static restore(id: string, state: string): Run {
    return new Run(id, state);
  }

  toView(): RunView {
    return { id: this.id, state: this.state };
  }
}
