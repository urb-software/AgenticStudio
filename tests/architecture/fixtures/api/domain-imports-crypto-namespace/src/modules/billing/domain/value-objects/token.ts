import * as crypto from 'node:crypto';

export class Token {
  private constructor(readonly value: string) {}

  static of(): Token {
    return new Token(crypto.createHash('sha256').digest('hex'));
  }
}
