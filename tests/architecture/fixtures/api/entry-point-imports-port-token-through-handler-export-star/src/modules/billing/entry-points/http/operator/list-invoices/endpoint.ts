import {
  CLOCK,
  ListInvoicesHandler,
} from '../../../../application/features/list-invoices/handler.js';

export class ListInvoicesEndpoint {
  constructor(readonly handler: ListInvoicesHandler) {}

  token(): symbol {
    return CLOCK;
  }
}
