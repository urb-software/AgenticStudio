class Rounding {
  constructor(readonly step: number) {}

  static half(): number {
    return 5;
  }
}

export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents + new Rounding(1).step);
  }
}
