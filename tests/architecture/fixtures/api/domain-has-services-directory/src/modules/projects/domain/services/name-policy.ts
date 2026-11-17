export class NamePolicy {
  isValid(name: string): boolean {
    return name.trim().length > 0;
  }
}
