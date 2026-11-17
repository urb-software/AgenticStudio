export class RepositoryConnection {
  private constructor(readonly state: string) {}

  static restore(state: string): RepositoryConnection {
    return new RepositoryConnection(state);
  }
}
