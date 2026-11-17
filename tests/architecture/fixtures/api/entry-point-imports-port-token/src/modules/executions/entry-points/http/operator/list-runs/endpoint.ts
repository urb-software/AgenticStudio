import { CLOCK } from '../../../../application/ports/clock.js';

export class ListRunsEndpoint {
  token(): symbol {
    return CLOCK;
  }
}
