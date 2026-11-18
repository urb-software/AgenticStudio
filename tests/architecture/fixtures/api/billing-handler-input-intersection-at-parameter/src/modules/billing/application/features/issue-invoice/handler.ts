import type { InvoiceNumber } from '../../../domain/value-objects/invoice-number.js';

export interface IssueInvoiceInput {
  note: string;
}

export interface IssueInvoiceResult {
  id: string;
}

export class IssueInvoiceHandler {
  execute(input: IssueInvoiceInput & { number: InvoiceNumber }): Promise<IssueInvoiceResult> {
    return Promise.resolve({ id: input.number.value });
  }
}
