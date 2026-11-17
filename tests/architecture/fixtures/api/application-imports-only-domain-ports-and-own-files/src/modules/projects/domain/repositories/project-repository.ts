export class ProjectNameTakenError extends Error {
  constructor(name: string) {
    super(`Project name taken: ${name}`);
  }
}
