export interface IssueInvoiceInput {
  number: string;
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  execute(input: IssueInvoiceInput): Promise<IssueInvoiceResult>;
  execute(input: IssueInvoiceInput, prefix: string): Promise<IssueInvoiceResult>;
  execute(input: IssueInvoiceInput, prefix = ''): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: `${prefix}${input.number}` });
  }
}
