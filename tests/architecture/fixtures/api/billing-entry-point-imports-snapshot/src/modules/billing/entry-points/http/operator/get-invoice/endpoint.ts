import type { InvoiceSnapshot } from '../../../../domain/entities/invoice-snapshot.js';

export const toResponse = (invoice: InvoiceSnapshot) => ({ id: invoice.id });
