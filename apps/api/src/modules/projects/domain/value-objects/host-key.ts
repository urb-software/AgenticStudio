import { createHash } from 'node:crypto';

/** A Git host's SSH host key as `<type> <base64>`. Nothing here stores, logs or sends a key. */
export class HostKey {
  private constructor(readonly value: string) {}

  static of(value: string): HostKey {
    return new HostKey(value);
  }

  get fingerprint(): string {
    const data = this.value.trim().split(/\s+/)[1] ?? '';
    const digest = createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64');
    return `SHA256:${digest.replace(/=+$/, '')}`;
  }
}
