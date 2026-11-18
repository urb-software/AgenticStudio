import { Money } from './money.js';

export class InvoiceRule {
  private constructor(readonly minimum: number) {}

  static at(minimum: number): InvoiceRule {
    return new InvoiceRule(minimum);
  }

  floor(): Money {
    return Money.of(this.minimum);
  }
}
