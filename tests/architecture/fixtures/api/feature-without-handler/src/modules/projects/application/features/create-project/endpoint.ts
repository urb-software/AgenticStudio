export class CreateProjectEndpoint {
  create(name: string): string {
    return name.trim();
  }
}
