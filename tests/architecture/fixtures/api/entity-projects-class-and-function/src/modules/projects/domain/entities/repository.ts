export class Repository {
  private constructor(readonly state: string) {}

  static restore(state: string): Repository {
    return new Repository(state);
  }
}

export function derivedFlag(state: string): boolean {
  return state === 'ready';
}
