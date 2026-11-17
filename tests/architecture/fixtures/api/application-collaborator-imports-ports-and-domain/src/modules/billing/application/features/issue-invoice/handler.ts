import { InvoiceNumbering } from '../../invoice-numbering.js';

export type IssueInvoiceInput = number;
export type IssueInvoiceResult = string;

export class IssueInvoiceHandler {
  constructor(private readonly numbering: InvoiceNumbering) {}

  execute(sequence: IssueInvoiceInput): IssueInvoiceResult {
    return this.numbering.next(sequence).value;
  }
}
