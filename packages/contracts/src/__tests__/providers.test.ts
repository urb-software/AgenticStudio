import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_DEFAULT, PROVIDER_MODELS, PROVIDERS } from '../index.js';

describe('PROVIDER_MODELS', () => {
  it('has one list per Provider', () => {
    expect(Object.keys(PROVIDER_MODELS)).toEqual([...PROVIDERS]);
  });

  it('lists the models the compliance records approve, each led by the CLI default', () => {
    expect(PROVIDER_MODELS.claude_code).toEqual([MODEL_DEFAULT, 'opus', 'sonnet', 'haiku']);
    expect(PROVIDER_MODELS.codex).toEqual([
      MODEL_DEFAULT,
      'gpt-6.2-astra',
      'gpt-6.2-sol',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]);
    expect(MODEL_DEFAULT).toBe('default');
  });
});

describe('the providers subpath', () => {
  it('stays free of imports, so a browser takes it without zod', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'providers.ts'), 'utf8');
    expect(text).not.toMatch(/^\s*(import|export)\b[^\n]*\bfrom\b/m);
  });

  it('is the same list the package root exports', async () => {
    const subpath = await import('../providers.js');
    expect(subpath.PROVIDERS).toBe(PROVIDERS);
    expect(subpath.PROVIDER_MODELS).toBe(PROVIDER_MODELS);
  });
});
