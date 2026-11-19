import type { InvoiceData } from './invoice-data.js';
import type { InvoiceState } from '../value-objects/invoice-state.js';
import { InvoiceState as State } from '../value-objects/invoice-state.js';

export class Invoice {
  readonly state: InvoiceState;

  private constructor(readonly id: string) {
    this.state = State.restore(false);
  }

  static restore(data: InvoiceData): Invoice {
    return new Invoice(data.id);
  }
}
