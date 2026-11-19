import type { InvoiceData } from './invoice-data.js';
import { InvoicePolicy } from '../value-objects/invoice-policy.js';

export class Invoice {
  private constructor(readonly id: string) {}

  static restore(data: InvoiceData): Invoice {
    return new Invoice(data.id);
  }

  isDue(): boolean {
    return InvoicePolicy.standard().allows(this.id);
  }
}
