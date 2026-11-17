export type IssueInvoiceInput = number;
export type IssueInvoiceResult = string;

export class IssueInvoiceHandler {
  execute(sequence: IssueInvoiceInput): IssueInvoiceResult {
    return String(sequence);
  }
}
