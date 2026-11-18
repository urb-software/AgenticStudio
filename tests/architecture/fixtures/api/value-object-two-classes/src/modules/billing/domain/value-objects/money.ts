export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }
}

export class Discount {
  private constructor(readonly percent: number) {}

  static of(percent: number): Discount {
    return new Discount(percent);
  }
}
