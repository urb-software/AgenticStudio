import type { Invoice } from '../entities/invoice.js';
import type { InvoicePolicy } from '../value-objects/invoice-policy.js';

export interface InvoiceRepository {
  find(id: string): Promise<Invoice | null>;
  findPolicy(id: string): Promise<InvoicePolicy | null>;
}
