import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import {
  PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER,
  PREVIEW_SNAPSHOT_GRACE_MS,
} from '../../../ports/preview-environment-file-snapshots.js';
import { SweepPreviewEnvironmentFilesHandler } from '../handler.js';

const ID = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const T0 = new Date('2026-11-24T10:00:00.000Z');

describe('SweepPreviewEnvironmentFilesHandler', () => {
  let operations: InMemoryPreviewOperationRepository;
  let secrets: InMemorySecretStore;
  let handler: SweepPreviewEnvironmentFilesHandler;

  beforeEach(() => {
    operations = new InMemoryPreviewOperationRepository();
    secrets = new InMemorySecretStore();
    handler = new SweepPreviewEnvironmentFilesHandler(operations, secrets, {
      leaseSeconds: 60,
      logMaxBytes: 1024,
      snapshotGraceMs: PREVIEW_SNAPSHOT_GRACE_MS,
    });
  });

  const owner = { owner: PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER };

  async function holdSnapshot() {
    await operations.add(
      PreviewOperation.requestBuild({
        id: ID,
        projectId: PROJECT,
        commit: PreviewCommit.of('a'.repeat(40)),
        composeFile: PreviewComposeFile.of('compose.yaml'),
        service: PreviewService.of('web'),
        port: PreviewPort.of(3000),
        limits: PreviewLimits.of({
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
        }),
        now: T0,
      }),
    );
    await operations.claimNext(CONTROLLER, T0);
    const secretId = await secrets.put('DB=test-only-pw', owner);
    await operations.change(ID, (held) => {
      held.recordEnvironmentFile(CONTROLLER, { path: '.env', secretId });
    });
    return secretId;
  }

  it('deletes an unreferenced snapshot older than an hour and keeps the rest', async () => {
    const kept = await holdSnapshot();
    const orphan = await secrets.put('DB=orphan-value', owner);
    const other = await secrets.put('x', { owner: 'projects.deploy-key' });
    secrets.now = PREVIEW_SNAPSHOT_GRACE_MS + 1;
    const fresh = await secrets.put('DB=fresh-value', owner);

    await handler.execute();

    expect(secrets.values.has(orphan)).toBe(false);
    expect(secrets.values.has(kept)).toBe(true);
    expect(secrets.values.has(other)).toBe(true);
    expect(secrets.values.has(fresh)).toBe(true);
  });

  it('never throws, whatever the secret store does', async () => {
    await secrets.put('DB=orphan-value', owner);
    secrets.now = PREVIEW_SNAPSHOT_GRACE_MS + 1;
    secrets.failWith = new Error('store down');

    await expect(handler.execute()).resolves.toBeUndefined();
  });

  it('goes on with the next snapshot when one cannot be deleted', async () => {
    const first = await secrets.put('DB=one-value', owner);
    const second = await secrets.put('DB=two-value', owner);
    secrets.now = PREVIEW_SNAPSHOT_GRACE_MS + 1;
    secrets.failNextDeleteWith = new Error('boom');

    await handler.execute();

    expect([first, second].filter((id) => secrets.values.has(id))).toHaveLength(1);
  });
});
