import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Provider } from '@agentic-studio/contracts';
import { ManagedGuardrails, readManagedFiles } from '../managed-guardrails.js';
import { installManagedGuardrails } from './fixtures/managed-guardrails.js';

// Issue #134: before every Run step (and at start) the worker checks Studio's root-owned managed
// guardrail files: present, real files, owned by root, not writable by others, in a directory
// only root can change, and byte-equal (SHA-256) to the copy the worker ships. Linux only, like
// the worker: runs in CI, skips elsewhere. Here the files live under a temporary root and the
// expected owner is the test's own uid (a test cannot create root-owned files).

const uid = () => process.getuid?.() ?? 0;

describe.skipIf(process.platform !== 'linux')("Studio's managed guardrails", () => {
  let root: string;
  const check = (ownerUid = uid()) => new ManagedGuardrails({ root, ownerUid });
  const installed = (path: string) => join(root, path);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'studio-managed-'));
    await installManagedGuardrails(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists the installed files per provider, from the manifest', async () => {
    const files = await readManagedFiles();

    expect(
      files.filter((file) => file.provider === 'claude_code').map((file) => file.path),
    ).toEqual([
      '/etc/claude-code/managed-settings.json',
      '/usr/local/lib/agentic-studio/guardrails/claude-guard.mjs',
    ]);
    expect(files.filter((file) => file.provider === 'codex').map((file) => file.path)).toEqual([
      '/etc/codex/managed_config.toml',
      '/etc/codex/requirements.toml',
      '/usr/local/lib/agentic-studio/guardrails/claude-guard.mjs',
    ]);
  });

  it.each<Provider>(['claude_code', 'codex'])(
    'passes when every file of %s is in place',
    async (provider) => {
      expect(await check().problem(provider)).toBeNull();
    },
  );

  const cases: [Provider, string][] = [
    ['claude_code', '/etc/claude-code/managed-settings.json'],
    ['claude_code', '/usr/local/lib/agentic-studio/guardrails/claude-guard.mjs'],
    ['codex', '/etc/codex/managed_config.toml'],
    ['codex', '/etc/codex/requirements.toml'],
    ['codex', '/usr/local/lib/agentic-studio/guardrails/claude-guard.mjs'],
  ];

  it.each(cases)('%s: a missing %s', async (provider, path) => {
    unlinkSync(installed(path));

    expect(await check().problem(provider)).toBe(`managed guardrails missing or changed: ${path}`);
  });

  it.each(cases)('%s: %s changed by one byte', async (provider, path) => {
    writeFileSync(installed(path), '\n', { flag: 'a' });

    expect(await check().problem(provider)).toBe(`managed guardrails missing or changed: ${path}`);
  });

  it.each<[Provider, string]>([
    ['claude_code', '/etc/claude-code/managed-settings.json'],
    ['codex', '/etc/codex/managed_config.toml'],
  ])(
    '%s: files owned by another user than the expected one (first: %s)',
    async (provider, path) => {
      expect(await check(uid() + 1).problem(provider)).toBe(
        `managed guardrails missing or changed: ${path}`,
      );
    },
  );

  it.each(cases)('%s: %s writable by others', async (provider, path) => {
    chmodSync(installed(path), 0o664);

    expect(await check().problem(provider)).toBe(`managed guardrails missing or changed: ${path}`);
  });

  it.each(cases)('%s: %s in a directory others can write', async (provider, path) => {
    chmodSync(join(installed(path), '..'), 0o777);

    expect(await check().problem(provider)).toMatch(/^managed guardrails missing or changed: \//);
  });

  it.each(cases)(
    '%s: %s replaced by a symbolic link to an identical copy',
    async (provider, path) => {
      const target = join(root, 'agent-copy');
      // An identical copy the agent could change later: still refused, never followed.
      writeFileSync(target, readFileSync(installed(path)));
      unlinkSync(installed(path));
      symlinkSync(target, installed(path));

      expect(await check().problem(provider)).toBe(
        `managed guardrails missing or changed: ${path}`,
      );
    },
  );

  it('refuses a directory in place of a file', async () => {
    const path = '/etc/codex/requirements.toml';
    unlinkSync(installed(path));
    mkdirSync(installed(path));

    expect(await check().problem('codex')).toBe(`managed guardrails missing or changed: ${path}`);
  });

  it.each<Provider>(['claude_code', 'codex'])(
    '%s: refuses a hook interpreter that is missing, a symbolic link or writable by others',
    async (provider) => {
      const node = installed('/usr/local/bin/node');
      const expected = 'managed guardrails missing or changed: /usr/local/bin/node';
      chmodSync(node, 0o775);
      expect(await check().problem(provider)).toBe(expected);
      unlinkSync(node);
      expect(await check().problem(provider)).toBe(expected);
      symlinkSync(process.execPath, node);
      expect(await check().problem(provider)).toBe(expected);
    },
  );

  it('checks only the files of the provider asked about', async () => {
    unlinkSync(installed('/etc/codex/requirements.toml'));

    expect(await check().problem('claude_code')).toBeNull();
    expect(await check().problem('codex')).not.toBeNull();
  });

  it('expects root as the owner by default', async () => {
    // The test's files belong to the test's user, never root (CI does not run tests as root).
    if (uid() === 0) return;
    expect(await new ManagedGuardrails({ root }).problem('claude_code')).toBe(
      'managed guardrails missing or changed: /etc/claude-code/managed-settings.json',
    );
  });
});
