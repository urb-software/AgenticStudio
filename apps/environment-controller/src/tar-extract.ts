import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, symlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** The archive is not a tar the controller accepts: reported as `archive_invalid`. */
export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ExtractLimits {
  /** Most bytes read from the stream, padding included. */
  maxBytes: number;
  maxEntries: number;
  /** Longest entry path in bytes (default 1024). */
  maxPathBytes?: number;
  /** Deepest entry path in segments (default 64). */
  maxDepth?: number;
}

export interface ExtractSummary {
  entries: number;
  files: number;
  bytes: number;
}

const BLOCK = 512;
const MAX_PAX_BYTES = 64 * 1024;
const MAX_LINK_BYTES = 4096;
const CHUNK = 64 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A byte stream read in exact amounts, capped in total. */
class ByteSource {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private done = false;
  total = 0;

  constructor(
    private readonly iterator: AsyncIterator<Uint8Array>,
    private readonly maxBytes: number,
  ) {}

  private async fill(minimum: number): Promise<void> {
    while (this.buffered < minimum && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        return;
      }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      this.total += chunk.length;
      if (this.total > this.maxBytes)
        throw new ArchiveError('the archive is larger than the limit');
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
  }

  /** Exactly `count` bytes; `null` at a clean end of the stream; an error when it stops midway. */
  async take(count: number): Promise<Buffer | null> {
    await this.fill(count);
    if (this.buffered === 0) return null;
    if (this.buffered < count) throw new ArchiveError('the archive ends in the middle of an entry');
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.buffered -= count;
    return all.subarray(0, count);
  }

  /** At least one and at most `max` bytes. */
  async takeUpTo(max: number): Promise<Buffer> {
    await this.fill(1);
    const first = this.chunks[0];
    if (!first) throw new ArchiveError('the archive ends in the middle of an entry');
    const part = first.subarray(0, max);
    if (first.length > max) this.chunks[0] = first.subarray(max);
    else this.chunks.shift();
    this.buffered -= part.length;
    return part;
  }

  async skip(count: number): Promise<void> {
    let left = count;
    while (left > 0) left -= (await this.takeUpTo(Math.min(left, CHUNK))).length;
  }

  /** Reads to the end of the stream (the cap still applies); whether only zeros remained. */
  async drain(): Promise<boolean> {
    let zeros = true;
    for (;;) {
      await this.fill(CHUNK);
      const rest = Buffer.concat(this.chunks);
      this.chunks = [];
      this.buffered = 0;
      if (rest.length === 0) return zeros;
      if (rest.some((byte) => byte !== 0)) zeros = false;
    }
  }
}

interface Header {
  name: string;
  mode: number;
  size: number;
  type: string;
  linkname: string;
}

const isZeroBlock = (block: Buffer) => block.every((byte) => byte === 0);

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(block: Buffer, start: number, length: number, what: string): number {
  const field = block.subarray(start, start + length);
  if ((field[0]! & 0x80) !== 0) throw new ArchiveError(`${what} uses an unsupported encoding`);
  const value = field
    .toString('ascii')
    .replace(/\0[\s\S]*$/, '')
    .trim();
  if (!/^[0-7]+$/.test(value)) throw new ArchiveError(`${what} is not an octal number`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new ArchiveError(`${what} is too large`);
  return parsed;
}

function parseHeader(block: Buffer): Header {
  const declared = octal(block, 148, 8, 'the header checksum');
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  if (sum !== declared) throw new ArchiveError('a header checksum does not match');
  const magic = block.subarray(257, 263).toString('latin1');
  const posix = magic === 'ustar\0';
  if (!posix && magic !== 'ustar ') throw new ArchiveError('an entry is not in ustar format');
  const prefix = posix ? text(block, 345, 155) : '';
  const name = text(block, 0, 100);
  return {
    name: prefix === '' ? name : `${prefix}/${name}`,
    mode: octal(block, 100, 8, 'a mode'),
    size: octal(block, 124, 12, 'a size'),
    type: String.fromCharCode(block[156]!),
    linkname: text(block, 157, 100),
  };
}

/** Parses pax records (`<length> <key>=<value>\n`); anything malformed is refused. */
function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number(data.subarray(offset, space === -1 ? offset : space).toString('ascii'));
    if (space === -1 || !Number.isInteger(length) || length <= space - offset + 1) {
      throw new ArchiveError('a pax header is malformed');
    }
    const end = offset + length;
    if (end > data.length || data[end - 1] !== 0x0a) {
      throw new ArchiveError('a pax header is malformed');
    }
    const record = data.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) throw new ArchiveError('a pax header is malformed');
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset = end;
  }
  return records;
}

/** The path as segments, or an error: relative, no `.`, `..`, empty segment or NUL. */
function entrySegments(raw: string, directory: boolean, limits: Required<ExtractLimits>): string[] {
  if (raw === '' || raw.includes('\0')) throw new ArchiveError('an entry has an empty path');
  if (Buffer.byteLength(raw) > limits.maxPathBytes) throw new ArchiveError('a path is too long');
  if (raw.startsWith('/')) throw new ArchiveError('an entry has an absolute path');
  const trimmed = directory && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segments = trimmed.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ArchiveError('an entry path leaves its place or is not normal');
  }
  if (segments.length > limits.maxDepth) throw new ArchiveError('a path is too deep');
  return segments;
}

/** Whether `target`, relative to a directory `depth` segments below the root, stays inside it. */
function staysInside(target: string, depth: number): boolean {
  let level = depth;
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    level += part === '..' ? -1 : 1;
    if (level < 0) return false;
  }
  return true;
}

type Kind = 'file' | 'directory' | 'symlink';

/**
 * Unpacks a tar stream (ustar with pax headers) into the directory `root`, trusting nothing in
 * it: only files, directories and checked symlinks; no escaping, repeated or symlink-nested
 * path; symlinks last, resolving inside the root. Anything else throws `ArchiveError`.
 */
export async function extractTar(
  stream: AsyncIterable<Uint8Array>,
  root: string,
  limits: ExtractLimits,
): Promise<ExtractSummary> {
  const full: Required<ExtractLimits> = { maxPathBytes: 1024, maxDepth: 64, ...limits };
  const source = new ByteSource(stream[Symbol.asyncIterator](), full.maxBytes);
  const kinds = new Map<string, Kind>();
  const links: { path: string; target: string }[] = [];
  let files = 0;
  let pending = new Map<string, string>();

  for (;;) {
    const block = await source.take(BLOCK);
    if (block === null) throw new ArchiveError('the archive has no end marker');
    if (isZeroBlock(block)) {
      const second = await source.take(BLOCK);
      if (second === null || !isZeroBlock(second))
        throw new ArchiveError('the end marker is broken');
      break;
    }
    const header = parseHeader(block);
    const padding = (BLOCK - (header.size % BLOCK)) % BLOCK;

    if (header.type === 'x' || header.type === 'g') {
      if (header.size > MAX_PAX_BYTES) throw new ArchiveError('a pax header is too large');
      const data = await source.take(header.size);
      if (header.size > 0 && data === null) throw new ArchiveError('a pax header is cut off');
      await source.skip(padding);
      const records = parsePax(data ?? Buffer.alloc(0));
      if (header.type === 'x') pending = records;
      continue;
    }

    const extended = pending;
    pending = new Map();
    const type = header.type === '\0' ? '0' : header.type;
    if (type !== '0' && type !== '5' && type !== '2') {
      throw new ArchiveError(`an entry has the unsupported type ${JSON.stringify(header.type)}`);
    }
    if (type !== '0' && extended.has('size')) {
      throw new ArchiveError('a size override is allowed on a file only');
    }
    if (kinds.size >= full.maxEntries) throw new ArchiveError('the archive has too many entries');
    const directory = type === '5';
    const segments = entrySegments(extended.get('path') ?? header.name, directory, full);
    const path = segments.join('/');
    if (kinds.has(path)) throw new ArchiveError('an entry path appears twice');
    for (let end = 1; end < segments.length; end += 1) {
      const ancestor = kinds.get(segments.slice(0, end).join('/'));
      if (ancestor === 'symlink' || ancestor === 'file') {
        throw new ArchiveError('an entry lies below a file or a symlink');
      }
    }
    const absolute = join(root, ...segments);

    if (type === '2') {
      const target = extended.get('linkpath') ?? header.linkname;
      if (
        target === '' ||
        target.includes('\0') ||
        target.startsWith('/') ||
        Buffer.byteLength(target) > MAX_LINK_BYTES ||
        !staysInside(target, segments.length - 1)
      ) {
        throw new ArchiveError('a symlink points outside the source directory');
      }
      await source.skip(header.size + padding);
      kinds.set(path, 'symlink');
      links.push({ path: absolute, target });
    } else if (directory) {
      await source.skip(header.size + padding);
      await mkdir(absolute, { recursive: true, mode: 0o755 });
      if (!(await lstat(absolute)).isDirectory()) throw new ArchiveError('a directory is a file');
      kinds.set(path, 'directory');
    } else {
      const size = extended.has('size') ? Number(extended.get('size')) : header.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError('a size is not valid');
      await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
      await writeEntry(source, absolute, size, header.mode);
      await source.skip((BLOCK - (size % BLOCK)) % BLOCK);
      kinds.set(path, 'file');
      files += 1;
    }
  }
  if (!(await source.drain())) throw new ArchiveError('data follows the end marker');

  await makeSymlinks(root, links);
  return { entries: kinds.size, files, bytes: source.total };
}

async function writeEntry(source: ByteSource, path: string, size: number, mode: number) {
  const executable = (mode & 0o111) !== 0;
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      executable ? 0o755 : 0o644,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ArchiveError('an entry collides with another');
    }
    throw error;
  }
  try {
    let left = size;
    while (left > 0) {
      const part = await source.takeUpTo(Math.min(left, CHUNK));
      await handle.write(part);
      left -= part.length;
    }
  } finally {
    await handle.close();
  }
}

async function makeSymlinks(root: string, links: { path: string; target: string }[]) {
  const realRoot = await realpath(root);
  for (const link of links) {
    await mkdir(dirname(link.path), { recursive: true, mode: 0o755 });
    try {
      await symlink(link.target, link.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ArchiveError('a symlink collides with another entry');
      }
      throw error;
    }
  }
  for (const link of links) {
    let resolved: string;
    try {
      resolved = await realpath(link.path);
    } catch {
      throw new ArchiveError('a symlink does not resolve');
    }
    const inside = relative(realRoot, resolved);
    if (inside === '..' || inside.startsWith(`..${sep}`)) {
      throw new ArchiveError('a symlink resolves outside the source directory');
    }
  }
}
