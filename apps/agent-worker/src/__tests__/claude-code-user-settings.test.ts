import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userSettingsProblem } from '../claude-code/user-settings.js';

// Reviews R4 and N1 of #129: before every Run step the worker checks the agent user's own
// Claude Code settings (the approved Mode keeps the user setting source). Coordinator decision:
// absent, or only `$schema`. Key names only, never values.

describe("the agent user's Claude Code settings", () => {
  let home: string;
  const write = (file: string, content: unknown) =>
    writeFileSync(
      join(home, '.claude', file),
      typeof content === 'string' ? content : JSON.stringify(content),
    );

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'studio-claude-home-'));
    mkdirSync(join(home, '.claude'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lets a step start when the files are absent or hold only $schema', async () => {
    expect(await userSettingsProblem(home)).toBeNull();
    write('settings.json', { $schema: 'https://json.schemastore.org/claude-code-settings.json' });
    write('settings.local.json', {});
    expect(await userSettingsProblem(home)).toBeNull();
    expect(await userSettingsProblem(undefined)).toBeNull();
  });

  it.each([
    'hooks',
    'env',
    'apiKeyHelper',
    'permissions',
    'mcpServers',
    'enabledMcpjsonServers',
    'awsAuthRefresh',
    'awsCredentialExport',
    'enabledPlugins',
    'extraKnownMarketplaces',
    'otelHeadersHelper',
    'forceLoginMethod',
    'statusLine',
    // Even a harmless-looking key: only $schema is allowed.
    'model',
  ])('stops a step for %s, naming the key only', async (key) => {
    write('settings.json', { $schema: 'x', [key]: 'test-only-secret-value' });

    const problem = await userSettingsProblem(home);

    expect(problem).toBe(
      `Claude Code user settings contain ${key}; the operator must review them.`,
    );
    expect(problem).not.toContain('test-only-secret-value');
  });

  it('checks settings.local.json too, and names each key once', async () => {
    write('settings.json', { hooks: {}, env: {} });
    write('settings.local.json', { env: {}, apiKeyHelper: 'echo x' });

    expect(await userSettingsProblem(home)).toBe(
      'Claude Code user settings contain hooks, env, apiKeyHelper; the operator must review them.',
    );
  });

  it.each(['{ not json', '[]', '"text"', 'null'])(
    'stops a step for a file it cannot check: %j',
    async (content) => {
      write('settings.json', content);

      expect(await userSettingsProblem(home)).toBe(
        'Claude Code user settings could not be checked (~/.claude/settings.json); the operator must review them.',
      );
    },
  );

  it.skipIf(process.platform === 'win32')('follows a symbolic link to the real file', async () => {
    const elsewhere = join(home, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify({ mcpServers: { x: { command: 'y' } } }));
    symlinkSync(elsewhere, join(home, '.claude', 'settings.json'));

    expect(await userSettingsProblem(home)).toBe(
      'Claude Code user settings contain mcpServers; the operator must review them.',
    );
  });
});
