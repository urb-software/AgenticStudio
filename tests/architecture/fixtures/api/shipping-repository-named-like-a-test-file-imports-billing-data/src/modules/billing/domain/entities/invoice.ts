import type { InvoiceData } from './invoice-data.js';

export class Invoice {
  private constructor(readonly id: string) {}

  static restore(data: InvoiceData): Invoice {
    return new Invoice(data.id);
  }
}
