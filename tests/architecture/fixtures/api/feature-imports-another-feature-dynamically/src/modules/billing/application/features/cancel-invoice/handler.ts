export type CancelInvoiceResult = string;

export class CancelInvoiceHandler {
  async execute(): Promise<CancelInvoiceResult> {
    const { GetInvoiceHandler } = await import('../get-invoice/handler.js');
    return new GetInvoiceHandler().execute();
  }
}
