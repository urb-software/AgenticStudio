export class Repository {
  private constructor(readonly state: string) {}

  static restore(state: string): Repository {
    return new Repository(state);
  }
}

export function isRepository(value: unknown): value is Repository {
  return value instanceof Repository;
}
