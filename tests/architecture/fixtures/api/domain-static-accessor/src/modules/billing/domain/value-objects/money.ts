export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }

  static get zeroCents(): number {
    return 0;
  }
}
