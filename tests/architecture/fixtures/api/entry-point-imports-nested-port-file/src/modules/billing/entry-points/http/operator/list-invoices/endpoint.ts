import { SYSTEM_CLOCK } from '../../../../application/ports/clocks/system-clock.js';

export class ListInvoicesEndpoint {
  token(): symbol {
    return SYSTEM_CLOCK;
  }
}
