import { Currency } from './currency.js';

export class Money {
  private constructor(
    readonly amount: number,
    readonly currency: string,
  ) {}

  static of(amount: number): Money {
    return new Money(amount, Currency.DEFAULT);
  }
}
