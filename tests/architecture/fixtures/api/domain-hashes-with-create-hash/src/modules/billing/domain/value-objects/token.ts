import { createHash } from 'node:crypto';

export class Token {
  private constructor(readonly value: string) {}

  static of(): Token {
    return new Token(createHash('sha256').update('x').digest('hex'));
  }
}
