import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveError, extractTar } from '../tar-extract.js';
import { chunked, directory, end, entry, file, pax, tar } from './fixtures/tar-builder.js';

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxEntries: 100 };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'controller-tar-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const unpack = (data: Buffer, limits = LIMITS) => extractTar(chunked(data), root, limits);
const refused = (data: Buffer, limits = LIMITS) =>
  expect(unpack(data, limits)).rejects.toBeInstanceOf(ArchiveError);
const listing = () => readdirSync(root, { recursive: true }).map(String).sort();

describe('extractTar: what is accepted', () => {
  it('unpacks files and directories, across chunk boundaries', async () => {
    const big = 'x'.repeat(5000);
    const summary = await unpack(
      tar(
        pax({ comment: 'a'.repeat(40) }, 'g'),
        directory('src/'),
        file('src/a.txt', 'hello'),
        file('src/deep/b.txt', big),
        file('run.sh', '#!/bin/sh\n', 0o755),
      ),
    );
    expect(summary).toMatchObject({ entries: 4, files: 3 });
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(root, 'src/deep/b.txt'), 'utf8')).toBe(big);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
      expect(statSync(join(root, 'src/a.txt')).mode & 0o777).toBe(0o644);
    }
  });

  it('takes the path from a pax header and a prefix field', async () => {
    await unpack(
      tar(
        pax({ path: `long/${'n'.repeat(150)}.txt` }),
        file('ignored', 'one'),
        entry({ name: 'tail.txt', prefix: 'head/dir', content: 'two' }),
      ),
    );
    expect(existsSync(join(root, 'long', `${'n'.repeat(150)}.txt`))).toBe(true);
    expect(readFileSync(join(root, 'head/dir/tail.txt'), 'utf8')).toBe('two');
  });

  it('accepts an empty archive and trailing padding of zeros', async () => {
    await expect(unpack(end())).resolves.toMatchObject({ entries: 0 });
    await expect(
      unpack(Buffer.concat([tar(file('a', '1')), Buffer.alloc(8192)])),
    ).resolves.toBeTruthy();
  });
});

describe('extractTar: attack cases are refused', () => {
  it.each([
    ['an absolute path', file('/etc/passwd', 'x')],
    ['a parent segment', file('a/../../outside.txt', 'x')],
    ['a leading parent segment', file('../outside.txt', 'x')],
    ['a dot segment', file('./a.txt', 'x')],
    ['an empty segment', file('a//b.txt', 'x')],
    ['a NUL in a pax path', Buffer.concat([pax({ path: 'a\0b' }), file('x', '1')])],
    ['a pax path that leaves the root', Buffer.concat([pax({ path: '../x' }), file('x', '1')])],
    ['a file path with a trailing slash', file('dir/', 'x')],
    ['a hard link', entry({ name: 'h', type: '1', linkname: 'a' })],
    ['a character device', entry({ name: 'd', type: '3' })],
    ['a block device', entry({ name: 'd', type: '4' })],
    ['a fifo', entry({ name: 'd', type: '6' })],
    ['a GNU long name', entry({ name: '././@LongLink', type: 'L', content: 'x\0' })],
    ['a non-ustar entry', entry({ name: 'a', magic: 'XXXXX\0' })],
  ])('refuses %s', async (_name, data) => {
    await refused(tar(data));
    expect(listing()).toEqual([]);
  });

  it('refuses a path over 1024 bytes and one deeper than 64 segments', async () => {
    await refused(tar(pax({ path: 'a'.repeat(1025) }), file('x', '1')));
    const deep = Array.from({ length: 65 }, () => 'd').join('/');
    await refused(tar(pax({ path: `${deep}/f` }), file('x', '1')));
    const fine = Array.from({ length: 63 }, () => 'd').join('/');
    await expect(unpack(tar(pax({ path: `${fine}/f` }), file('x', '1')))).resolves.toBeTruthy();
  });

  it('refuses a duplicate path, whatever the types', async () => {
    await refused(tar(file('a.txt', '1'), file('a.txt', '2')));
    await refused(tar(directory('d/'), directory('d/')));
    await refused(tar(file('d', '1'), directory('d/')));
  });

  it('refuses an entry below a file', async () => {
    await refused(tar(file('a', '1'), file('a/b', '2')));
  });

  it('refuses a corrupt header checksum, a truncated archive and a missing end marker', async () => {
    const good = tar(file('a.txt', 'hello'));
    const flipped = Buffer.from(good);
    flipped[0] = flipped[0]! ^ 0xff;
    await refused(flipped);
    await refused(good.subarray(0, 700));
    await refused(file('a.txt', 'hello'));
    await refused(Buffer.concat([file('a.txt', 'hello'), Buffer.alloc(512), Buffer.from('junk')]));
  });

  it('refuses data after the end marker', async () => {
    await refused(Buffer.concat([tar(file('a', '1')), Buffer.from('trailing data')]));
  });

  it('refuses a base-256 size', async () => {
    const base256 = file('a', '1');
    base256[124] = 0x80;
    base256.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += base256[i]!;
    base256.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    await refused(tar(base256));
  });

  it('refuses a malformed pax header', async () => {
    await refused(tar(entry({ name: 'p', type: 'x', content: '99 path=a\n' }), file('x', '1')));
    await refused(tar(entry({ name: 'p', type: 'x', content: 'nolength' }), file('x', '1')));
  });

  it('refuses more entries than the limit and more bytes than the limit', async () => {
    const many = tar(...Array.from({ length: 4 }, (_, i) => file(`f${i}`, 'x')));
    await refused(many, { maxBytes: 1 << 20, maxEntries: 3 });
    await refused(tar(file('big', 'x'.repeat(4000))), { maxBytes: 2048, maxEntries: 10 });
  });

  it('counts padding and trailing zeros towards the byte limit', async () => {
    await refused(Buffer.concat([tar(file('a', '1')), Buffer.alloc(10240)]), {
      maxBytes: 4096,
      maxEntries: 10,
    });
  });
});
