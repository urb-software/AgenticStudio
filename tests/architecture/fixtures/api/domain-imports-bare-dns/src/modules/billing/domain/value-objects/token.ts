import { lookup } from 'dns';

export class Token {
  private constructor(readonly value: string) {}

  static of(): Token {
    return new Token(String(lookup.length));
  }
}
