import type { Invoice } from '../entities/invoice.js';
import type { InvoiceFacts } from '../entities/invoice-facts.js';
import type { InvoiceSnapshot } from '../entities/invoice-snapshot.js';

export interface InvoiceRepository {
  find(id: string): Promise<Invoice | null>;
  findSnapshot(id: string): Promise<InvoiceSnapshot | null>;
  factsOf(id: string): Promise<InvoiceFacts>;
}
