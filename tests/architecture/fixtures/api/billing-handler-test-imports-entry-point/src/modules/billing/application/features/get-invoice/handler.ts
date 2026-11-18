export interface GetInvoiceResult {
  id: string;
}

export class GetInvoiceHandler {
  constructor(private readonly source: () => Promise<GetInvoiceResult>) {}

  execute(): Promise<GetInvoiceResult> {
    return this.source();
  }
}
