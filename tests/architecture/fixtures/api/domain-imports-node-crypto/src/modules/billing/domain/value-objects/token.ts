import { randomBytes } from 'node:crypto';

export class Token {
  private constructor(readonly value: string) {}

  static of(): Token {
    return new Token(randomBytes(4).toString('hex'));
  }
}
