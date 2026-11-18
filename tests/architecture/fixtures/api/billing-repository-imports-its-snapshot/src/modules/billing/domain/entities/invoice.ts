import type { InvoiceSnapshot } from './invoice-snapshot.js';

export class Invoice {
  private constructor(readonly id: string) {}

  snapshot(): InvoiceSnapshot {
    return { id: this.id };
  }
}
