export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }

  static total(amounts: Money[]): number {
    return amounts.reduce((sum, money) => sum + money.cents, 0);
  }
}
