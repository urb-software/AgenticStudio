export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number) {
    return new Money(cents);
  }
}
