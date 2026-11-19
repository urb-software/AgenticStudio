export interface MoneyData {
  readonly cents: number;
}

export class Money {
  private constructor(readonly cents: number) {}

  static restore(data: MoneyData): Money {
    return new Money(data.cents);
  }

  toData(): MoneyData {
    return { cents: this.cents };
  }
}
