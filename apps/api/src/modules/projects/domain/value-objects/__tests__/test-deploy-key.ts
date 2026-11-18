import { generateKeyPairSync } from 'node:crypto';

function sshString(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * An ed25519 key pair made when the test runs: a public key line as Git hosts publish it, and a
 * private key in PKCS#8. Not the OpenSSH form the adapter writes; the tests that need that use the
 * adapter itself.
 */
export function testDeployKey(comment = 'test'): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const blob = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(raw)]);
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`,
  };
}
