import type { Tax } from './tax.js';

export interface Money {
  readonly amount: number;
  readonly tax: Tax;
}
