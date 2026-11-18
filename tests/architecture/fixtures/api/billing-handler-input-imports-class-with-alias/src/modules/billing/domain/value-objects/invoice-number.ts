export const INVOICE_KINDS = ['standard', 'credit'] as const;

export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export class InvoiceNumber {
  private constructor(readonly value: string) {}

  static of(value: string): InvoiceNumber {
    return new InvoiceNumber(value);
  }
}
