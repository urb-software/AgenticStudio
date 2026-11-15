import { beforeEach, describe, expect, it } from 'vitest';
import type { RunEnvironmentFile } from '../../../../projects/contracts/index.js';
import { RUN_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../domain/entities/run-environment-file.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { ClaimRunHandler } from '../handler.js';

// Issue #96: handing out work under the concurrency limits, after the lost-worker sweep.
const [A, B, C] = [
  '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
  '5b4d0e3a-6f7c-4d8e-9fa0-1b2c3d4e5f6a',
] as const;
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');

describe('ClaimRunHandler', () => {
  let runs: InMemoryRunRepository;
  let now: Date;
  let handler: ClaimRunHandler;
  let secrets: InMemorySecretStore;
  // Each project's current Environment file (Issue #104); test values only.
  let files: Map<string, RunEnvironmentFile>;
  let filesFail: Error | undefined;

  const queue = (projectId: string) =>
    runs.add({
      projectId,
      provider: 'claude_code',
      task: `Task of ${projectId}`,
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    now = T0;
    secrets = new InMemorySecretStore();
    files = new Map();
    filesFail = undefined;
    const environmentFiles = {
      forProject: (projectId: string) =>
        filesFail ? Promise.reject(filesFail) : Promise.resolve(files.get(projectId) ?? null),
    };
    handler = new ClaimRunHandler(
      runs,
      { now: () => now },
      { seconds: 60 },
      environmentFiles,
      secrets,
    );
  });

  it('hands out nothing when no Run is queued', async () => {
    expect(await handler.execute(WORKER)).toBeNull();
  });

  it('hands out the oldest queued Run as preparing, held by the worker', async () => {
    const first = await queue(A);
    await queue(B);

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({
      id: first.id,
      state: 'preparing',
      claimedBy: WORKER,
      startedAt: T0,
    });
  });

  it('keeps one active Run per project and two across the server; the rest wait in order', async () => {
    const a1 = await queue(A);
    const a2 = await queue(A);
    const b1 = await queue(B);
    const c1 = await queue(C);

    expect((await handler.execute(WORKER))?.id).toBe(a1.id);
    expect((await handler.execute(OTHER_WORKER))?.id).toBe(b1.id);
    expect(await handler.execute(WORKER)).toBeNull();

    expect((await runs.findById(a2.id))?.state).toBe('queued');
    expect((await runs.findById(c1.id))?.state).toBe('queued');
  });

  it('fails a Run without a remote URL as preparation_failed and hands out the next (review of #117)', async () => {
    const orphan = await runs.add({
      projectId: A,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: '',
    });
    const next = await queue(B);

    const claimed = await handler.execute(WORKER);

    expect(claimed?.id).toBe(next.id);
    expect(await runs.findById(orphan.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'preparation_failed' },
      claimedBy: null,
    });
  });

  it('sweeps lost workers first, which frees their places', async () => {
    const a1 = await queue(A);
    const b1 = await queue(B);
    const c1 = await queue(C);
    await handler.execute(WORKER);
    await handler.execute(WORKER);
    now = new Date(T0.getTime() + 61_000);

    const claimed = await handler.execute(OTHER_WORKER);

    expect(claimed?.id).toBe(c1.id);
    expect((await runs.findById(a1.id))?.failure?.code).toBe('worker_lost');
    expect((await runs.findById(b1.id))?.failure?.code).toBe('worker_lost');
  });
});

describe('ClaimRunHandler with Environment files (Issue #104)', () => {
  const FILE = { path: '.env', content: 'DB_PASSWORD=test-only-pw-1\n' };
  let runs: InMemoryRunRepository;
  let secrets: InMemorySecretStore;
  let current: RunEnvironmentFile | null;
  let failRead: Error | undefined;
  let handler: ClaimRunHandler;

  const queue = () =>
    runs.add({
      projectId: A,
      provider: 'claude_code',
      task: 'Run the integration tests',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    secrets = new InMemorySecretStore();
    current = FILE;
    failRead = undefined;
    handler = new ClaimRunHandler(
      runs,
      { now: () => T0 },
      { seconds: 60 },
      {
        forProject: () =>
          failRead ? Promise.reject(failRead) : Promise.resolve(current && { ...current }),
      },
      secrets,
    );
  });

  it("hands the Project's file to the claiming worker and keeps a Run-scoped snapshot", async () => {
    const queued = await queue();

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({ id: queued.id, environmentFileSupplied: true });
    expect(claimed?.environmentFile).toEqual(FILE);
    expect((await runs.findById(queued.id))?.environmentFileSupplied).toBe(true);
    const snapshot = await runs.findEnvironmentFileSecret(queued.id);
    expect(secrets.values.get(snapshot!)).toBe(FILE.content);
    expect(secrets.owners.get(snapshot!)).toBe(RUN_ENVIRONMENT_FILE_SECRET_OWNER);
  });

  it('keeps the snapshot of the claim when the file changes or goes afterwards', async () => {
    const queued = await queue();
    await handler.execute(WORKER);

    current = { path: '.env', content: 'DB_PASSWORD=test-only-changed\n' };
    const snapshot = await runs.findEnvironmentFileSecret(queued.id);

    expect(secrets.values.get(snapshot!)).toBe(FILE.content);
  });

  it('records that no file was supplied when the Project has none', async () => {
    current = null;
    const queued = await queue();

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({ environmentFileSupplied: false, environmentFile: null });
    expect(await runs.findEnvironmentFileSecret(queued.id)).toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  it('fails the Run with preparation_failed when the file cannot be read, handing out nothing', async () => {
    failRead = new Error('The secret could not be decrypted.');
    const queued = await queue();

    expect(await handler.execute(WORKER)).toBeNull();
    expect(await runs.findById(queued.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'preparation_failed' },
      environmentFileSupplied: false,
    });
  });

  it('fails the Run and stores nothing when the snapshot cannot be stored', async () => {
    secrets.failWith = new Error('The secret store is unavailable.');
    const queued = await queue();

    expect(await handler.execute(WORKER)).toBeNull();
    expect((await runs.findById(queued.id))?.failure?.code).toBe('preparation_failed');
    secrets.failWith = undefined;
    expect(secrets.values.size).toBe(0);
  });
});
