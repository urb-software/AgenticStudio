function split(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const character of text) {
    if (character === ',') {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

export class Money {
  private constructor(readonly cents: number) {}

  static parse(text: string): Money {
    return new Money(Number(split(text)[0]));
  }
}
