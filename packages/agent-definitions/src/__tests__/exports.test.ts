import * as contracts from '@agentic-studio/contracts/providers';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as definitions from '../index.js';
import * as limits from '../limits.js';

describe('the Provider constants', () => {
  it('are re-exported, so the web app needs only this package', () => {
    expect(definitions.PROVIDERS).toBe(contracts.PROVIDERS);
    expect(definitions.PROVIDER_MODELS).toBe(contracts.PROVIDER_MODELS);
    expect(definitions.MODEL_DEFAULT).toBe(contracts.MODEL_DEFAULT);
  });

  it('come with the Provider type', () => {
    const provider: definitions.Provider = definitions.PROVIDERS[0];
    expect(definitions.PROVIDER_MODELS[provider]).toContain(definitions.MODEL_DEFAULT);
  });
});

describe('RESERVED_AGENT_NAMES', () => {
  it('names one built-in Default agent per Provider, and the fixed agents route', () => {
    const defaults = definitions.PROVIDERS.map(
      (provider) => `default-${provider.replaceAll('_', '-')}`,
    );
    expect([...definitions.RESERVED_AGENT_NAMES].sort()).toEqual(
      [...defaults, 'definitions-repository'].sort(),
    );
  });
});

describe('the skill API', () => {
  it('exports the validation, the finder and the shell pattern', () => {
    expect(typeof definitions.validateSkillFolder).toBe('function');
    expect(typeof definitions.findSkillFolders).toBe('function');
    expect(definitions.SHELL_LINE).toBeInstanceOf(RegExp);
  });
});

describe('the limits subpath', () => {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { exports: Record<string, { default: string }> };

  it('is exported, so a client can take the limits without the YAML parser', () => {
    expect(manifest.exports['./limits']?.default).toBe('./dist/limits.js');
    expect(limits.AGENT_NAME_PATTERN).toBe(definitions.AGENT_NAME_PATTERN);
  });

  it('imports nothing of the package that parses YAML', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'limits.ts'), 'utf8');
    expect(source).not.toMatch(/from '(\.\/(?!limits)|yaml)/);
    expect(source).not.toContain("from 'yaml'");
  });
});
