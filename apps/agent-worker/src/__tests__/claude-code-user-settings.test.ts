import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_USER_SETTINGS, userSettingsProblem } from '../claude-code/user-settings.js';

// Review R4 of #129: before every Run step the worker checks the agent user's own Claude Code
// settings (the approved Mode keeps the user setting source). Key names only, never values.

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

  it('lets a step start without settings files, or with harmless ones', async () => {
    expect(await userSettingsProblem(home)).toBeNull();
    write('settings.json', { model: 'some-model', theme: 'dark', includeCoAuthoredBy: false });
    expect(await userSettingsProblem(home)).toBeNull();
    expect(await userSettingsProblem(undefined)).toBeNull();
  });

  it.each(FORBIDDEN_USER_SETTINGS)('stops a step for %s, naming the key only', async (key) => {
    write('settings.json', { [key]: 'test-only-secret-value' });

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

  it('stops a step for a file it cannot check', async () => {
    write('settings.json', '{ not json');

    expect(await userSettingsProblem(home)).toBe(
      'Claude Code user settings could not be checked (~/.claude/settings.json); the operator must review them.',
    );
  });

  it.skipIf(process.platform === 'win32')('follows a symbolic link to the real file', async () => {
    const elsewhere = join(home, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify({ mcpServers: { x: { command: 'y' } } }));
    symlinkSync(elsewhere, join(home, '.claude', 'settings.json'));

    expect(await userSettingsProblem(home)).toBe(
      'Claude Code user settings contain mcpServers; the operator must review them.',
    );
  });
});
