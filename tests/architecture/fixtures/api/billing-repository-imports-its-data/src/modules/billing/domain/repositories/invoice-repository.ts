import type { Invoice } from '../entities/invoice.js';

export interface InvoiceRepository {
  find(id: string): Promise<Invoice | null>;
  listNewestFirst(): Promise<Invoice[]>;
}
