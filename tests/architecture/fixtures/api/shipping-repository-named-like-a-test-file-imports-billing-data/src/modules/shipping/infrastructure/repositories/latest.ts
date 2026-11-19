import type { InvoiceData } from '../../../billing/domain/entities/invoice-data.js';

export class Latest {
  readonly invoices: InvoiceData[] = [];
}
