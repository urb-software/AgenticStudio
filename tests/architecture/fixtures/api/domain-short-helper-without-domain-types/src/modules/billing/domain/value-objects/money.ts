function digitsOf(text: string): string {
  return text.replace(/[^0-9]/g, '');
}

export class Money {
  private constructor(readonly cents: number) {}

  static parse(text: string): Money {
    return new Money(Number(digitsOf(text)));
  }
}
