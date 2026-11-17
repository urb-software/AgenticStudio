import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeployKey } from '../deploy-key.js';
import { HostKey } from '../host-key.js';

describe('HostKey.fingerprint', () => {
  it('is SHA256 of the key blob in unpadded base64, as ssh-keygen -l prints it', () => {
    const { publicKey } = DeployKey.generate('host');
    const [type, data] = publicKey.split(' ') as [string, string];
    const expected = createHash('sha256')
      .update(Buffer.from(data, 'base64'))
      .digest('base64')
      .replace(/=+$/, '');
    expect(HostKey.of(`${type} ${data}`).fingerprint).toBe(`SHA256:${expected}`);
    expect(HostKey.of(`${type} ${data}`).fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
