import { Money } from './money.js';

export class InvoiceBuilder {
  total(cents: number): Money {
    return Money.of(cents);
  }

  static free(): Money | null {
    return Money.of(0);
  }
}
