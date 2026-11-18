import type { InvoiceSnapshot } from '../../domain/entities/invoice-snapshot.js';
import type { InvoiceRepository } from '../../domain/repositories/invoice-repository.js';

export class InMemoryInvoiceRepository implements InvoiceRepository {
  find(): Promise<null> {
    return Promise.resolve(null);
  }

  listNewestFirst(): Promise<InvoiceSnapshot[]> {
    return Promise.resolve([]);
  }
}
