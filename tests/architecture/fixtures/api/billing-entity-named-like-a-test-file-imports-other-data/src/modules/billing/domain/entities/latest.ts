import type { InvoiceData } from './invoice-data.js';

export class Latest {
  private constructor(readonly id: string) {}

  static restore(data: InvoiceData): Latest {
    return new Latest(data.id);
  }
}
