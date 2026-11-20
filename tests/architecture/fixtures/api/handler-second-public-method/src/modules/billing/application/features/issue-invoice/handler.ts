export interface IssueInvoiceInput {
  number: string;
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  execute(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: input.number });
  }

  // A second entry point into the handler: a caller would reach it without `execute`.
  forInvoice(number: string): Promise<IssueInvoiceResult> {
    return this.execute({ number });
  }
}
