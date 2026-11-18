import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { GeneratedDeployKey } from '../../domain/value-objects/generated-deploy-key.js';

const ED25519 = 'ssh-ed25519';

/**
 * Generates the project's Deploy key, the SSH key pair Studio uses to reach a private Repository;
 * nothing here stores, logs or sends a key.
 */
export class Ed25519DeployKeyGenerator {
  private static sshString(value: Buffer | string): Buffer {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  }

  private static uint32(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  }

  /**
   * Generates an ed25519 Deploy key in the formats OpenSSH reads. No passphrase: the key lives in the
   * secret store and is written owner-only for one Git operation at a time.
   */
  generate(comment: string): GeneratedDeployKey {
    const sshString = Ed25519DeployKeyGenerator.sshString;
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    const seed = Buffer.from(jwk.d!, 'base64url');
    const publicBytes = Buffer.from(jwk.x!, 'base64url');
    const publicBlob = Buffer.concat([sshString(ED25519), sshString(publicBytes)]);

    const check = randomBytes(4);
    let section = Buffer.concat([
      check,
      check,
      sshString(ED25519),
      sshString(publicBytes),
      sshString(Buffer.concat([seed, publicBytes])),
      sshString(comment),
    ]);
    const padding = (8 - (section.length % 8)) % 8;
    section = Buffer.concat([
      section,
      Buffer.from(Array.from({ length: padding }, (_, i) => i + 1)),
    ]);
    const blob = Buffer.concat([
      Buffer.from('openssh-key-v1\0', 'latin1'),
      sshString('none'),
      sshString('none'),
      sshString(''),
      Ed25519DeployKeyGenerator.uint32(1),
      sshString(publicBlob),
      sshString(section),
    ]);
    seed.fill(0);
    const body = blob
      .toString('base64')
      .match(/.{1,70}/g)!
      .join('\n');
    return {
      privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`,
      publicKey: `${ED25519} ${publicBlob.toString('base64')} ${comment}`,
    };
  }
}
