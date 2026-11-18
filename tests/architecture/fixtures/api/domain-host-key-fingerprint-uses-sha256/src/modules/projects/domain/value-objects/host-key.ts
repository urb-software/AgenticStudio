import { createHash } from 'node:crypto';

export class HostKey {
  private constructor(readonly value: string) {}

  static of(value: string): HostKey {
    return new HostKey(value);
  }

  get fingerprint(): string {
    return createHash('sha256').update(this.value).digest('base64');
  }
}
