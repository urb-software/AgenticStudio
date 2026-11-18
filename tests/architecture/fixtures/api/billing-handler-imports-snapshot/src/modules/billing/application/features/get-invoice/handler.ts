import type { InvoiceSnapshot } from '../../../domain/entities/invoice-snapshot.js';

export type GetInvoiceResult = InvoiceSnapshot;

export class GetInvoiceHandler {
  constructor(private readonly source: () => Promise<InvoiceSnapshot>) {}

  execute(): Promise<GetInvoiceResult> {
    return this.source();
  }
}
