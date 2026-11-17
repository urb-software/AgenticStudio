import type { Invoice } from '../entities/invoice.js';
import type * as values from '../value-objects/invoice-totals.js';

export interface InvoiceRepository {
  add(invoice: Invoice): Promise<void>;
  totals(id: string): Promise<values.InvoiceTotals>;
}
