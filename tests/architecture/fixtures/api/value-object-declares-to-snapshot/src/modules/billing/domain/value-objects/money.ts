export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }

  toSnapshot(): { cents: number } {
    return { cents: this.cents };
  }
}
