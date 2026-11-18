export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }

  static parse(text: string): Money | null {
    return /^[0-9]+$/.test(text) ? Money.of(Number(text)) : null;
  }

  private static zero(): number {
    return 0;
  }

  static free(): Money {
    return Money.of(Money.zero());
  }
}
