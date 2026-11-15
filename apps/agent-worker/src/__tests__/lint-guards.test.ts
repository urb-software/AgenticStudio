import { ESLint } from 'eslint';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Review of #116: the agent worker's ESLint config bans the ways of loading code that the
// architecture gate cannot see, so nothing reaches node:child_process past the spawn boundary.
// This proves the guard catches each form in production code (and only there).

const eslint = new ESLint({ cwd: join(import.meta.dirname, '..', '..') });

async function ruleIds(code: string, file = 'src/probe.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: file });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'parse-error');
}

describe('agent worker lint guards against hidden module loading', () => {
  it.each([
    ['a non-literal import()', "const name = 'child_process';\nexport const m = import(name);\n"],
    ['require()', "export const m = require('child_process');\n"],
    [
      'createRequire',
      "import { createRequire } from 'node:module';\nexport const r = createRequire(import.meta.url);\n",
    ],
  ])('refuses %s', async (_case, code) => {
    expect(await ruleIds(code)).toContain('no-restricted-syntax');
  });

  it.each(['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule'])(
    'refuses the process loader property %s however process is reached',
    async (property) => {
      for (const code of [
        `export const b = process.${property};\n`,
        `export const b = globalThis.process.${property};\n`,
        `const p = process;\nexport const b = p.${property};\n`,
        `export const b = process['${property}'];\n`,
        `const { ${property}: b } = process;\nexport { b };\n`,
      ]) {
        expect(await ruleIds(code), code).toContain('no-restricted-syntax');
      }
    },
  );

  it.each([
    ['eval', "export const m = eval('import(\\'node:child_process\\')');\n", 'no-eval'],
    ['new Function', "export const f = new Function('return 1');\n", 'no-new-func'],
    ['a string timer', "setTimeout('globalThis.x = 1', 0);\n", 'no-implied-eval'],
  ])('refuses %s', async (_case, code, rule) => {
    expect(await ruleIds(code)).toContain(rule);
  });

  it.each(['node:vm', 'vm'])('refuses importing %s', async (name) => {
    expect(
      await ruleIds(`import { runInThisContext } from '${name}';\nexport { runInThisContext };\n`),
    ).toContain('no-restricted-imports');
  });

  it('accepts a literal import()', async () => {
    expect(await ruleIds("export const m = import('./config.js');\n")).toEqual([]);
  });

  it('leaves tests alone', async () => {
    expect(
      await ruleIds("export const m = require('child_process');\n", 'src/__tests__/probe.ts'),
    ).not.toContain('no-restricted-syntax');
  });
});
