import { Invoice } from '../../domain/entities/invoice.js';
import type { InvoiceData } from '../../domain/entities/invoice-data.js';
import type { InvoiceRepository } from '../../domain/repositories/invoice-repository.js';

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly rows: InvoiceData[] = [{ id: 'one' }];

  find(): Promise<Invoice | null> {
    const row = this.rows[0];
    return Promise.resolve(row ? Invoice.restore({ id: row.id }) : null);
  }

  listNewestFirst(): Promise<Invoice[]> {
    return Promise.resolve(this.rows.map((row) => Invoice.restore({ id: row.id })));
  }
}
