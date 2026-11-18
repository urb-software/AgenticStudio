import type * as entities from '../../../domain/entities/invoice.js';

export type GetInvoiceResult = entities.Invoice;

export class GetInvoiceHandler {
  constructor(private readonly source: () => Promise<entities.Invoice>) {}

  execute(): Promise<GetInvoiceResult> {
    return this.source();
  }
}
