import type { InvoiceData } from '../../../../domain/entities/invoice-data.js';

export const toResponse = (invoice: InvoiceData) => ({ id: invoice.id });
