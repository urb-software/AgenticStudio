import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeployKey } from '../deploy-key.js';

/** Reads SSH wire-format fields (uint32, and strings as uint32 length + bytes) in order. */
class WireReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  uint32(): number {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  string(): Buffer {
    const length = this.uint32();
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  rest(): Buffer {
    const value = this.buffer.subarray(this.offset);
    this.offset = this.buffer.length;
    return value;
  }

  get done(): boolean {
    return this.offset === this.buffer.length;
  }
}

/** Decodes an `openssh-key-v1` private key (unencrypted) into its parts. */
function decodePrivateKey(armoured: string) {
  const lines = armoured.trim().split('\n');
  expect(lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----');
  expect(lines.at(-1)).toBe('-----END OPENSSH PRIVATE KEY-----');
  for (const line of lines.slice(1, -1)) expect(line.length).toBeLessThanOrEqual(70);
  const blob = Buffer.from(lines.slice(1, -1).join(''), 'base64');
  const magic = 'openssh-key-v1\0';
  expect(blob.subarray(0, magic.length).toString('latin1')).toBe(magic);
  const outer = new WireReader(blob.subarray(magic.length));
  const cipher = outer.string().toString();
  const kdf = outer.string().toString();
  const kdfOptions = outer.string().length;
  const count = outer.uint32();
  const publicBlob = outer.string();
  const privateSection = outer.string();
  expect(outer.done).toBe(true);
  const inner = new WireReader(privateSection);
  const check1 = inner.uint32();
  const check2 = inner.uint32();
  const type = inner.string().toString();
  const publicKey = inner.string();
  const secret = inner.string();
  const comment = inner.string().toString();
  const padding = inner.rest();
  return {
    cipher,
    kdf,
    kdfOptions,
    count,
    publicBlob,
    check1,
    check2,
    type,
    publicKey,
    secretBytes: secret,
    comment,
    padding,
    sectionLength: privateSection.length,
  };
}

describe('DeployKey.generate', () => {
  it('generates an ed25519 key pair: OpenSSH private key and a one-line public key', () => {
    const { privateKey, publicKey } = DeployKey.generate('studio-acme-shop');

    const [type, data, comment, ...rest] = publicKey.split(' ');
    expect(type).toBe('ssh-ed25519');
    expect(comment).toBe('studio-acme-shop');
    expect(rest).toEqual([]);

    const decoded = decodePrivateKey(privateKey);
    expect(decoded).toMatchObject({
      cipher: 'none',
      kdf: 'none',
      kdfOptions: 0,
      count: 1,
      type: 'ssh-ed25519',
      comment: 'studio-acme-shop',
    });
    expect(decoded.check1).toBe(decoded.check2);
    expect(decoded.sectionLength % 8).toBe(0);
    // Padding is 1, 2, 3, … up to the 8-byte block.
    expect([...decoded.padding]).toEqual([...decoded.padding].map((_, i) => i + 1));
    expect(decoded.padding.length).toBeLessThan(8);
    // The public blob is the one of the public key line.
    expect(decoded.publicBlob.toString('base64')).toBe(data);
    expect(decoded.publicKey).toHaveLength(32);
    expect(decoded.secretBytes).toHaveLength(64);
    expect(decoded.secretBytes.subarray(32)).toEqual(decoded.publicKey);

    // The seed and the public key are a real ed25519 pair.
    const toBase64Url = (bytes: Buffer) => bytes.toString('base64url');
    const key = createPrivateKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: toBase64Url(decoded.secretBytes.subarray(0, 32)),
        x: toBase64Url(decoded.publicKey),
      },
      format: 'jwk',
    });
    const signature = sign(null, Buffer.from('payload'), key);
    const publicJwk = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(decoded.publicKey) },
      format: 'jwk',
    });
    expect(verify(null, Buffer.from('payload'), publicJwk, signature)).toBe(true);
  });

  it('generates a new key pair every time', () => {
    const a = DeployKey.generate('studio-a');
    const b = DeployKey.generate('studio-a');
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('DeployKey.commentFor', () => {
  it.each([
    ['Acme Shop', 'studio-Acme-Shop'],
    ['  shop  ', 'studio-shop'],
    ['café / api', 'studio-caf-api'],
    ['a.b_c-d', 'studio-a.b_c-d'],
    ['$(rm -rf)', 'studio-rm-rf'],
    ['ü', 'studio-project'],
    ['x'.repeat(100), `studio-${'x'.repeat(64)}`],
  ])('turns %j into %j', (name, comment) => {
    expect(DeployKey.commentFor(name)).toBe(comment);
  });
});
