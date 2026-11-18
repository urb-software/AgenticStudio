import type { InvoiceNumber } from '../../../domain/value-objects/invoice-number.js';

export interface IssueInvoiceInput extends InvoiceNumber {
  note: string;
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  execute(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: input.value });
  }
}
