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

  // A public arrow property is a second entry point, like a method.
  forInvoice = (number: string): Promise<IssueInvoiceResult> => this.execute({ number });
}
