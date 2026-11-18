export const DEFAULT_CENTS = 100;

export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number = DEFAULT_CENTS): Money {
    return new Money(cents);
  }
}
