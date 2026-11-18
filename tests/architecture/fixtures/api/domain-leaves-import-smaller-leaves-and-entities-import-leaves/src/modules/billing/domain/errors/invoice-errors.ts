import { Currency } from '../value-objects/currency.js';

export class InvoiceAlreadyPaidError extends Error {
  readonly currency = Currency.DEFAULT;
}
