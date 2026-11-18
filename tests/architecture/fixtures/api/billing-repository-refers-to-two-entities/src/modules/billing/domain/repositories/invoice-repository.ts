import type { Customer } from '../entities/customer.js';
import type { Invoice } from '../entities/invoice.js';

export interface InvoiceRepository {
  add(invoice: Invoice, customer: Customer): Promise<void>;
}
