import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import {
  ENVIRONMENT_FILE_ORPHAN_AGE_MS,
  SecretStoreEnvironmentFileContents,
} from '../secret-store-environment-file-contents.js';

// Issue #104: Environment file contents in the secret store, under their own owner label.

describe('SecretStoreEnvironmentFileContents', () => {
  let secrets: InMemorySecretStore;
  let contents: SecretStoreEnvironmentFileContents;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message) => {
      warnings.push(String(message));
    });
    secrets = new InMemorySecretStore();
    contents = new SecretStoreEnvironmentFileContents(secrets);
  });

  afterEach(() => vi.restoreAllMocks());

  it('stores under projects.environment-file and reads it back; a deleted one reads as null', async () => {
    const reference = await contents.store('A=test-only-value');

    expect(secrets.owners.get(reference)).toBe('projects.environment-file');
    expect(await contents.read(reference)).toBe('A=test-only-value');
    await contents.discard(reference);
    expect(await contents.read(reference)).toBeNull();
  });

  it('lists only its own contents older than the grace period', async () => {
    const old = await contents.store('A=test-only-old');
    await secrets.put('key', { owner: 'projects.deploy-key' });
    secrets.now += ENVIRONMENT_FILE_ORPHAN_AGE_MS;
    await contents.store('B=test-only-new');

    expect(await contents.listOld()).toEqual([old]);
  });

  it('logs a failed discard by reference only, never the content, and does not throw', async () => {
    const reference = await contents.store('A=test-only-secret');
    secrets.failNextDeleteWith = new Error('down');

    await expect(contents.discard(reference)).resolves.toBeUndefined();

    expect(warnings.join('\n')).toContain(reference);
    expect(warnings.join('\n')).not.toContain('test-only-secret');
  });
});
