/** Builds tar archives for tests, byte for byte, including the broken ones. */

export interface EntrySpec {
  name: string;
  /** `0` file, `5` directory, `2` symlink, `x`/`g` pax, `1` hard link, ... */
  type?: string;
  content?: string | Buffer;
  linkname?: string;
  mode?: number;
  /** Replaces the size field of the header, to build a lying header. */
  declaredSize?: number;
  magic?: string;
  prefix?: string;
}

function field(value: string | number, length: number, octal = false): Buffer {
  const out = Buffer.alloc(length);
  const text = octal
    ? (value as number).toString(8).padStart(length - 1, '0')
    : Buffer.from(String(value));
  Buffer.from(text).copy(out, 0, 0, length - (octal ? 1 : 0));
  return out;
}

export function header(spec: EntrySpec): Buffer {
  const content = Buffer.from(spec.content ?? '');
  const block = Buffer.alloc(512);
  field(spec.name, 100).copy(block, 0);
  field(spec.mode ?? 0o644, 8, true).copy(block, 100);
  field(0, 8, true).copy(block, 108);
  field(0, 8, true).copy(block, 116);
  field(spec.declaredSize ?? content.length, 12, true).copy(block, 124);
  field(0, 12, true).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(spec.type ?? '0', 156, 'latin1');
  field(spec.linkname ?? '', 100).copy(block, 157);
  block.write(spec.magic ?? 'ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  if (spec.prefix) field(spec.prefix, 155).copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

function padded(content: Buffer): Buffer {
  const rest = (512 - (content.length % 512)) % 512;
  return Buffer.concat([content, Buffer.alloc(rest)]);
}

export function entry(spec: EntrySpec): Buffer {
  const content = Buffer.from(spec.content ?? '');
  return Buffer.concat([header(spec), padded(content)]);
}

export const file = (name: string, content: string | Buffer = '', mode = 0o644) =>
  entry({ name, content, mode });
export const directory = (name: string) => entry({ name, type: '5', mode: 0o755 });
export const link = (name: string, linkname: string) => entry({ name, type: '2', linkname });

/** A pax extended header (`x`) or global header (`g`) with these records. */
export function pax(records: Record<string, string>, type: 'x' | 'g' = 'x'): Buffer {
  const body = Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const rest = Buffer.from(` ${key}=${value}\n`);
      let length = rest.length + 1;
      while (String(length).length + rest.length !== length)
        length = String(length).length + rest.length;
      return Buffer.concat([Buffer.from(String(length)), rest]);
    }),
  );
  return entry({ name: 'pax', type, content: body });
}

export const end = (blocks = 2) => Buffer.alloc(512 * blocks);

export function tar(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, end()]);
}

export async function* chunked(data: Buffer, size = 700): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, offset + size);
  }
}
