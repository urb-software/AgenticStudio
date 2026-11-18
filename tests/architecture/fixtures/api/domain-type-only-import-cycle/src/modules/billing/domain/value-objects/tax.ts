import type { Money } from './money.js';

export interface Tax {
  readonly rate: number;
  readonly basis: Money;
}
