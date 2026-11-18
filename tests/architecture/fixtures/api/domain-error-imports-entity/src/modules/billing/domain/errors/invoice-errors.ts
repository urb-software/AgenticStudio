import type { Invoice } from '../entities/invoice.js';

// An error that refers to the entity it is about: the dependency points the wrong way.
export class InvoiceAlreadyPaidError extends Error {
  constructor(readonly invoice: Invoice) {
    super('The invoice is already paid.');
  }
}
