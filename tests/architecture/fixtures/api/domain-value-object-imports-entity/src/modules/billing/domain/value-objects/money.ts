import type { Invoice } from '../entities/invoice.js';

// A value object that refers to an entity: the dependency points the wrong way.
export interface Money {
  readonly amount: number;
  readonly invoice: Invoice;
}
