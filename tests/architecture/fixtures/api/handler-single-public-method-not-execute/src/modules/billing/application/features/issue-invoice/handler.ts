export interface IssueInvoiceInput {
  number: string;
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  run(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: input.number });
  }
}
