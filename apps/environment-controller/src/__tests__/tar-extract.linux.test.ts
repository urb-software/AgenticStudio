import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveError, extractTar } from '../tar-extract.js';
import { chunked, directory, file, link, pax, tar } from './fixtures/tar-builder.js';

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxEntries: 100 };

describe.skipIf(process.platform !== 'linux')('extractTar: symlinks (Linux)', () => {
  let base: string;
  let root: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'controller-tar-link-'));
    root = join(base, 'root');
    mkdirSync(root);
    writeFileSync(join(base, 'outside.txt'), 'secret');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const unpack = (data: Buffer) => extractTar(chunked(data), root, LIMITS);
  const refused = (data: Buffer) => expect(unpack(data)).rejects.toBeInstanceOf(ArchiveError);

  it('creates a symlink to a file inside the root, after the files', async () => {
    await unpack(tar(link('latest', 'dir/a.txt'), directory('dir/'), file('dir/a.txt', 'hi')));
    expect(lstatSync(join(root, 'latest')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'latest'))).toBe('dir/a.txt');
  });

  it('accepts a relative target that goes up and stays inside', async () => {
    await unpack(tar(file('a.txt', 'x'), link('d/up', '../a.txt')));
    expect(readlinkSync(join(root, 'd/up'))).toBe('../a.txt');
  });

  it.each([
    ['an absolute target', link('l', '/etc/passwd')],
    ['a target that leaves the root', link('l', '../outside.txt')],
    ['a deep target that leaves the root', link('d/l', '../../outside.txt')],
    ['a dangling target', link('l', 'missing.txt')],
    ['an empty target', link('l', '')],
  ])('refuses %s', async (_name, entry) => {
    await refused(tar(entry));
  });

  it('refuses an entry below a symlink (the escape through a symlinked directory)', async () => {
    await refused(tar(link('d', '.'), file('d/x.txt', 'pwned')));
    await refused(tar(link('d', 'e'), directory('e/'), file('d/x.txt', 'pwned')));
  });

  it('refuses a symlink that collides with a file', async () => {
    await refused(tar(file('a', '1'), link('a', 'b')));
  });

  it('refuses a symlink chain that resolves outside the root', async () => {
    await refused(tar(file('ok', '1'), link('a', 'b'), link('b', 'c'), link('c', 'ok/../../x')));
  });

  it('refuses a symlink loop', async () => {
    await refused(tar(link('a', 'b'), link('b', 'a')));
  });

  it('takes a symlink target from a pax linkpath, and judges that one', async () => {
    await unpack(tar(file('a.txt', 'x'), pax({ linkpath: 'a.txt' }), link('ok', '/etc/passwd')));
    expect(readlinkSync(join(root, 'ok'))).toBe('a.txt');
    await refused(tar(pax({ linkpath: '/etc/passwd' }), link('bad', 'a.txt')));
  });

  it('refuses a symlink over a directory made implicitly by a file below it', async () => {
    await refused(tar(file('a/x', '1'), link('a', 'b'), file('b', '2')));
  });

  it('never writes outside the root', async () => {
    await refused(tar(link('d', '.'), file('d/x.txt', 'x')));
    expect(() => lstatSync(join(base, 'x.txt'))).toThrow();
  });
});
