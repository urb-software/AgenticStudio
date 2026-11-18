import type { InvoiceResponse } from '../../../../entry-points/http/shared/invoice-response.js';
import { GetInvoiceHandler } from '../handler.js';

export const response = async (): Promise<InvoiceResponse> =>
  new GetInvoiceHandler(() => Promise.resolve({ id: '1' })).execute();
