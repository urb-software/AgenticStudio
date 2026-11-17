import { beforeEach, describe, expect, it } from 'vitest';
import { RUN_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../domain/entities/run-environment-file.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import { EnvironmentFileSecretValues } from '../environment-file-secret-values.js';

// Issue #104: a Run's log redaction gets the values of its Environment file snapshot.

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');

describe('EnvironmentFileSecretValues', () => {
  let runs: InMemoryRunRepository;
  let secrets: InMemorySecretStore;
  let values: EnvironmentFileSecretValues;
  let runId: string;

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    secrets = new InMemorySecretStore();
    values = new EnvironmentFileSecretValues(runs, secrets);
    await runs.add({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    });
    runId = (await runs.claimNext(WORKER, T0))!.id;
  });

  const attach = async (content: string) => {
    const snapshot = await secrets.put(content, { owner: RUN_ENVIRONMENT_FILE_SECRET_OWNER });
    await runs.attachEnvironmentFile(runId, WORKER, { path: '.env', secretRef: snapshot });
    return snapshot;
  };

  it("gives the snapshot's values while the Run goes on", async () => {
    await attach('DB_PASSWORD=test-only-pw\nX=1\n');
    expect(await values.forRun(runId)).toEqual(['test-only-pw']);
  });

  it('gives no values for a Run without a snapshot, or once it was deleted', async () => {
    expect(await values.forRun(runId)).toEqual([]);
    const snapshot = await attach('A=test-only-value');
    await secrets.delete(snapshot);
    expect(await values.forRun(runId)).toEqual([]);
  });

  it('fails closed when the secret store fails, so nothing is stored unredacted', async () => {
    await attach('A=test-only-value');
    secrets.failWith = new Error('The secret store is unavailable.');
    await expect(values.forRun(runId)).rejects.toThrow('unavailable');
  });
});
