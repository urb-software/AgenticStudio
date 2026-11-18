export class Invoice {
  private constructor(readonly id: string) {}

  static create(id: string): Invoice {
    return new Invoice(id);
  }
}
