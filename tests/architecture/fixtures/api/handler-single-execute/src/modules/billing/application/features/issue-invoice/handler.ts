export interface IssueInvoiceInput {
  number: string;
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  constructor(private readonly prefix: string) {}

  execute(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: this.format(input.number) });
  }

  private format(number: string): string {
    return `${this.prefix}${number}`;
  }
}
