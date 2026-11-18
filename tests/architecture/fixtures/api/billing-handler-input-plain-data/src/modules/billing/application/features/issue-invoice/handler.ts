import { InvoiceNumber, type InvoiceKind } from '../../../domain/value-objects/invoice-number.js';

export interface IssueInvoiceInput {
  number: string;
  kind: InvoiceKind;
  lines: { description: string; cents: number }[];
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  execute(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: InvoiceNumber.of(input.number).value });
  }
}
