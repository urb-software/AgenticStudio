import type { Invoice } from '../entities/invoice.js';
import type { InvoiceState } from '../value-objects/invoice-state.js';

export interface InvoiceRepository {
  find(id: string): Promise<Invoice | null>;
  findState(id: string): Promise<InvoiceState | null>;
}
