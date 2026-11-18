export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }

  static readonly byCents = (a: Money, b: Money) => a.cents - b.cents;
}
