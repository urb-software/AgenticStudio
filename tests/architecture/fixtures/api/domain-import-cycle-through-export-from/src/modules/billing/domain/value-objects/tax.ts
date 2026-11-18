import type { Money } from './money.js';

export interface Tax {
  readonly basis: Money;
}
