import type { Invoice } from '../entities/invoice.js';
import type { InvoiceFacts } from '../entities/invoice-facts.js';
import type { InvoiceData } from '../entities/invoice-data.js';

export interface InvoiceRepository {
  find(id: string): Promise<Invoice | null>;
  findData(id: string): Promise<InvoiceData | null>;
  factsOf(id: string): Promise<InvoiceFacts>;
}
