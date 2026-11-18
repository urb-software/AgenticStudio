import type { InvoiceResponse } from '../../../entry-points/http/shared/invoice-response.js';

export type GetInvoiceResult = InvoiceResponse;

export class GetInvoiceHandler {
  constructor(private readonly source: () => Promise<InvoiceResponse>) {}

  execute(): Promise<GetInvoiceResult> {
    return this.source();
  }
}
