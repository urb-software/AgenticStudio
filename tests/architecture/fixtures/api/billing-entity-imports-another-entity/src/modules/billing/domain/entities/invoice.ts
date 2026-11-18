import type { Customer } from './customer.js';

export class Invoice {
  private constructor(readonly customer: Customer) {}
}
