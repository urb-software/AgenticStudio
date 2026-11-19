import type { InvoiceData } from '../../../domain/entities/invoice-data.js';

export type GetInvoiceResult = InvoiceData;

export class GetInvoiceHandler {
  constructor(private readonly source: () => Promise<InvoiceData>) {}

  execute(): Promise<GetInvoiceResult> {
    return this.source();
  }
}
