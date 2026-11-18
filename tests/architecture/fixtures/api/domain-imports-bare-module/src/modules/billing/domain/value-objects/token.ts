import { createRequire } from 'module';

export class Token {
  private constructor(readonly value: string) {}

  static of(): Token {
    return new Token(String(createRequire.length));
  }
}
