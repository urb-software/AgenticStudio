import type { InvoiceData } from './invoice-data.js';
import type { PaymentData } from './payment-data.js';

export class Payment {
  private constructor(readonly id: string) {}

  static restore(data: PaymentData, invoice: InvoiceData): Payment {
    return new Payment(`${invoice.id}-${data.id}`);
  }
}
