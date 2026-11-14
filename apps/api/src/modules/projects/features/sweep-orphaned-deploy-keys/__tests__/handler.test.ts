import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretStoreUnavailableError } from '../../../../../platform/secrets/index.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { DeployKeyHandler, type StoredDeployKey } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import { DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS, SweepOrphanedDeployKeysHandler } from '../handler.js';

// Issue #76: deleting Deploy-key secrets no Repository references. The safety cases come first:
// a referenced secret, a fresh one and another owner's are never deleted.

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

describe('SweepOrphanedDeployKeysHandler', () => {
  let secrets: InMemorySecretStore;
  let deployKeys: DeployKeyHandler;
  let projects: InMemoryProjectRepository;
  let sweeper: SweepOrphanedDeployKeysHandler;
  let logs: string[];
  let warnings: string[];

  /** A Repository holding `key`, stored the way a Connect over SSH stores it. */
  async function sshRepository(projectId: string, key: StoredDeployKey) {
    projects.addProject(projectId, projectId.slice(0, 4));
    await projects.beginConnect({
      projectId,
      url: `git@github.com:acme/${projectId}.git`,
      identity: `github.com/acme/${projectId}`,
      integrationBranch: 'dev',
      deployKey: key,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    secrets = new InMemorySecretStore();
    deployKeys = new DeployKeyHandler(secrets, { knownHosts: [] });
    projects = new InMemoryProjectRepository();
    sweeper = new SweepOrphanedDeployKeysHandler(projects, deployKeys, {
      gracePeriodMs: DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
    });
    logs = [];
    warnings = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
  });

  it('has a grace period of one hour by default', () => {
    expect(DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS).toBe(HOUR_MS);
  });

  it('never deletes a Deploy key a Repository references, in any state, however old', async () => {
    const awaiting = await deployKeys.create('A');
    const disconnecting = await deployKeys.create('B');
    await sshRepository(A, awaiting);
    await sshRepository(B, disconnecting);
    await projects.beginDisconnect(B);
    secrets.now += 30 * 24 * HOUR_MS;

    await sweeper.sweep();

    expect([...secrets.values.keys()].sort()).toEqual(
      [awaiting.secretRef, disconnecting.secretRef].sort(),
    );
    expect(logs).toEqual([]);
  });

  it('keeps a fresh orphan inside the grace period, then deletes it once it is older', async () => {
    const orphan = await deployKeys.create('Shop');

    secrets.now += HOUR_MS - 1;
    await sweeper.sweep();
    expect(secrets.values.has(orphan.secretRef)).toBe(true);

    secrets.now += 1;
    await sweeper.sweep();
    expect(secrets.values.has(orphan.secretRef)).toBe(false);
  });

  it("never touches another owner's secrets, however old", async () => {
    const other = await secrets.put('another module value', { owner: 'agents.token' });
    const unowned = await secrets.put('a row from before owner labels', { owner: 'unowned' });
    secrets.now += 30 * 24 * HOUR_MS;

    await sweeper.sweep();

    expect([...secrets.values.keys()].sort()).toEqual([other, unowned].sort());
  });

  it('deletes the key of a connect that crashed between storing it and saving the reference', async () => {
    // The private key is stored, then the process dies before the Repository is saved.
    const crashed = await deployKeys.create('Shop');
    const kept = await deployKeys.create('Kept');
    await sshRepository(A, kept);
    secrets.now += 2 * HOUR_MS;

    await sweeper.sweep();

    expect(secrets.values.has(crashed.secretRef)).toBe(false);
    expect([...secrets.values.keys()]).toEqual([kept.secretRef]);
  });

  it('logs each deleted secret by its id only, never a value', async () => {
    const first = await deployKeys.create('One');
    const second = await deployKeys.create('Two');
    const privateKeys = [...secrets.values.values()];
    secrets.now += 2 * HOUR_MS;

    await sweeper.sweep();

    expect(logs).toEqual([
      `Deleted the orphaned Deploy key secret ${first.secretRef}.`,
      `Deleted the orphaned Deploy key secret ${second.secretRef}.`,
    ]);
    for (const key of privateKeys) {
      expect([...logs, ...warnings].join('\n')).not.toContain(key.split('\n')[1]!);
    }
  });

  it('keeps going past a delete that fails; the next sweep retries it', async () => {
    const failing = await deployKeys.create('One');
    await deployKeys.create('Two');
    secrets.now += 2 * HOUR_MS;
    secrets.failNextDeleteWith = new SecretStoreUnavailableError();

    await sweeper.sweep();

    expect([...secrets.values.keys()]).toEqual([failing.secretRef]);
    expect(warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Could not delete the orphaned Deploy key secret ${failing.secretRef}; .*SecretStoreUnavailableError`,
        ),
      ),
    ]);

    await sweeper.sweep();
    expect(secrets.values.size).toBe(0);
  });

  it('never throws when the secret store is unavailable, and deletes nothing', async () => {
    await deployKeys.create('Shop');
    secrets.now += 2 * HOUR_MS;
    secrets.failWith = new SecretStoreUnavailableError();

    await expect(sweeper.sweep()).resolves.toBeUndefined();

    secrets.failWith = undefined;
    expect(secrets.values.size).toBe(1);
    expect(warnings).toEqual([expect.stringMatching(/^Could not sweep orphaned Deploy keys; /)]);
  });

  it('deletes nothing when the Repositories cannot be read, and never throws', async () => {
    await deployKeys.create('Shop');
    secrets.now += 2 * HOUR_MS;
    vi.spyOn(projects, 'listDeployKeySecrets').mockRejectedValue(new Error('database down'));

    await expect(sweeper.sweep()).resolves.toBeUndefined();

    expect(secrets.values.size).toBe(1);
    expect(warnings).toEqual([expect.stringMatching(/^Could not sweep orphaned Deploy keys; /)]);
  });
});
