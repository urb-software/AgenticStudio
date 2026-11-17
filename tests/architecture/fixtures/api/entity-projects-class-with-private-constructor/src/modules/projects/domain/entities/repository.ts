export class RepositoryNotVerifiableError extends Error {}

export class Repository {
  private constructor(readonly state: string) {}

  static restore(state: string): Repository {
    return new Repository(state);
  }

  fetch(): void {
    if (this.state !== 'ready') throw new RepositoryNotVerifiableError();
  }
}
