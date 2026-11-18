import { createHash, randomBytes } from 'crypto';

export class Token {
  private constructor(readonly value: string) {}

  static of(): Token {
    return new Token(createHash('sha256').update(randomBytes(4)).digest('hex'));
  }
}
