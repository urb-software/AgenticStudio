import type { Invoice } from '../../../domain/entities/invoice.js';

export type GetInvoiceResult = Invoice;

export class GetInvoiceHandler {
  constructor(private readonly source: () => Promise<Invoice>) {}

  execute(): Promise<GetInvoiceResult> {
    return this.source();
  }
}
