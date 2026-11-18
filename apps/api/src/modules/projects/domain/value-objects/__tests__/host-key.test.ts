import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ed25519DeployKeyGenerator } from '../../../infrastructure/adapters/ed25519-deploy-key-generator.js';
import { HostKey } from '../host-key.js';

describe('HostKey.fingerprint', () => {
  it('is SHA256 of the key blob in unpadded base64, as ssh-keygen -l prints it', () => {
    const { publicKey } = new Ed25519DeployKeyGenerator().generate('host');
    const [type, data] = publicKey.split(' ') as [string, string];
    const expected = createHash('sha256')
      .update(Buffer.from(data, 'base64'))
      .digest('base64')
      .replace(/=+$/, '');
    expect(HostKey.of(`${type} ${data}`).fingerprint).toBe(`SHA256:${expected}`);
    expect(HostKey.of(`${type} ${data}`).fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
