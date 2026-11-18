export interface MoneyInput {
  cents: number;
}

export class InvalidMoneyError extends Error {}

export class Money {
  static readonly MAX_CENTS = 1_000_000;

  private constructor(readonly cents: number) {}

  static of(input: MoneyInput): Money {
    if (input.cents > Money.MAX_CENTS) throw new InvalidMoneyError('Too much.');
    return new Money(input.cents);
  }

  static restore(input: MoneyInput): Money {
    return new Money(input.cents);
  }
}
