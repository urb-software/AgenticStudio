function cents(money: Money): number {
  return money.cents;
}

export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }

  double(): Money {
    return Money.of(cents(this) * 2);
  }
}
