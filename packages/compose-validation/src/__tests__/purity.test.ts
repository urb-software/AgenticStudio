import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

const sources = readdirSync(SRC)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));

/** Every module specifier the file imports, exports from or dynamically imports. */
function specifiers(text: string): string[] {
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  return [...text.matchAll(pattern)].map((match) => match[1] as string);
}

describe('the package stays a pure function', () => {
  it('imports only its own files and the YAML parser', () => {
    const outside = sources.flatMap(({ file, text }) =>
      specifiers(text)
        .filter((name) => !name.startsWith('./') && name !== 'yaml')
        .map((name) => `${file}: ${name}`),
    );
    expect(outside).toEqual([]);
  });

  it('uses no Node built-in, process, file, network or dynamic code', () => {
    const forbidden = /\b(process\.|require\(|import\(|eval\(|new Function|fetch\(|Buffer\b)/;
    const found = sources.filter(({ text }) => forbidden.test(text)).map(({ file }) => file);
    expect(found).toEqual([]);
  });
});
