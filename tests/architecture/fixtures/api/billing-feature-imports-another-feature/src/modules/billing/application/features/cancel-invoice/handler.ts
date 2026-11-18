import { GetInvoiceHandler } from '../get-invoice/handler.js';

export type CancelInvoiceResult = string;

export class CancelInvoiceHandler {
  constructor(private readonly invoices: GetInvoiceHandler) {}

  execute(): CancelInvoiceResult {
    return this.invoices.execute();
  }
}
