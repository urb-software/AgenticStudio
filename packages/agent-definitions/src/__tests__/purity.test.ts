import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => file.endsWith('.ts') && !file.split('/').includes('__tests__'))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf8') }));

function specifiers(text: string): string[] {
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  return [...text.matchAll(pattern)].map((match) => match[1] as string);
}

describe('the package stays a pure function that runs in a browser', () => {
  it('finds its source files', () => {
    expect(sources.length).toBeGreaterThan(3);
  });

  it('includes the workflow source in what it checks', () => {
    expect(sources.map(({ file }) => file)).toContain('workflow.ts');
  });

  it('imports only its own files, the contracts providers subpath and the YAML parser', () => {
    const outside = sources.flatMap(({ file, text }) =>
      specifiers(text)
        .filter(
          (name) =>
            !name.startsWith('./') &&
            !name.startsWith('../') &&
            name !== 'yaml' &&
            name !== '@agentic-studio/contracts/providers',
        )
        .map((name) => `${file}: ${name}`),
    );
    expect(outside).toEqual([]);
  });

  it('uses no Node module, process, file, network, timer or dynamic code', () => {
    const forbidden =
      /node:|\bprocess[.[]|\b(globalThis|require|eval|fetch|Buffer|TextEncoder|TextDecoder|setTimeout|setInterval|setImmediate)\b|new Function|\bimport\(/;
    const found = sources.filter(({ text }) => forbidden.test(text)).map(({ file }) => file);
    expect(found).toEqual([]);
  });
});
