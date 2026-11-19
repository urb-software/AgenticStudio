export class InvoicePolicy {
  private constructor(readonly prefix: string) {}

  static standard(): InvoicePolicy {
    return new InvoicePolicy('inv-');
  }

  allows(id: string): boolean {
    return id.startsWith(this.prefix);
  }
}
