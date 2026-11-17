import { IssueInvoiceHandler } from './features/issue-invoice/handler.js';

export class InvoiceNumbering {
  constructor(private readonly issuing: IssueInvoiceHandler) {}

  next(sequence: number): string {
    return this.issuing.execute(sequence);
  }
}
