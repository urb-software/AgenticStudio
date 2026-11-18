import type { Invoice } from '../entities/invoice.js';
import type { InvoiceTotals } from '../value-objects/invoice-totals.js';

export interface InvoiceRepository {
  add(invoice: Invoice): Promise<void>;
  totals: (id: string) => Promise<InvoiceTotals>;
}
