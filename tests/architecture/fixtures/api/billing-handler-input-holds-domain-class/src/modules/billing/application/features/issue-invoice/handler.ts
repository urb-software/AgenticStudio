import type { InvoiceNumber } from '../../../domain/value-objects/invoice-number.js';

export interface IssueInvoiceInput {
  number: InvoiceNumber;
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  execute(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: input.number.value });
  }
}
