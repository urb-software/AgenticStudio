import { createHash } from 'node:crypto';

/**
 * A Git host's SSH host key as `<type> <base64>` (Issue #62). Nothing here stores, logs or
 * sends a key.
 */
export class HostKey {
  private constructor(readonly value: string) {}

  static of(value: string): HostKey {
    return new HostKey(value);
  }

  /** The SHA256 fingerprint, as `ssh-keygen -l` prints it: `SHA256:<base64>`. */
  get fingerprint(): string {
    const data = this.value.trim().split(/\s+/)[1] ?? '';
    const digest = createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64');
    return `SHA256:${digest.replace(/=+$/, '')}`;
  }
}
