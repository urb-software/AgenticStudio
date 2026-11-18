import type { Invoice } from '../entities/invoice.js';
import type { InvoiceSnapshot } from '../entities/invoice-snapshot.js';

export interface InvoiceRepository {
  find(id: string): Promise<Invoice | null>;
  listNewestFirst(): Promise<InvoiceSnapshot[]>;
}
