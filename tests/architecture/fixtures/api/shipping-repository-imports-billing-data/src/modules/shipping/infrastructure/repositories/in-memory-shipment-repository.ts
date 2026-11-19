import type { InvoiceData } from '../../../billing/domain/entities/invoice-data.js';

export class InMemoryShipmentRepository {
  readonly invoices: InvoiceData[] = [];
}
