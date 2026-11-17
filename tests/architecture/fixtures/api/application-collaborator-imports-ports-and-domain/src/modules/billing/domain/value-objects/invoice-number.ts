export class InvoiceNumber {
  private constructor(readonly value: string) {}

  static of(year: number, sequence: number): InvoiceNumber {
    return new InvoiceNumber(`${year}-${sequence}`);
  }
}
