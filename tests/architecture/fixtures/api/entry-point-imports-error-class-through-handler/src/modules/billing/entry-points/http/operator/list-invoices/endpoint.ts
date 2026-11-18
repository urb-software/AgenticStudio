import {
  ClockUnavailableError,
  ListInvoicesHandler,
} from '../../../../application/features/list-invoices/handler.js';

export class ListInvoicesEndpoint {
  constructor(readonly handler: ListInvoicesHandler) {}

  fails(error: unknown): boolean {
    return error instanceof ClockUnavailableError;
  }
}
