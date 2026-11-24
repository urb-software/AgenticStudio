import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import {
  PreviewOperationNotFoundError,
  PreviewOperationNotHeldError,
} from '../../../../domain/errors/preview-operation-errors.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../ports/preview-environment-file-snapshots.js';
import type { PreviewSecretValues } from '../../../ports/preview-secret-values.js';
import { ReportPreviewOperationStateHandler } from '../handler.js';

const ID = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OTHER = '11111111-2222-4333-8444-555555555555';
const T0 = new Date('2026-11-24T10:00:00.000Z');
const T1 = new Date('2026-11-24T10:00:15.000Z');

describe('ReportPreviewOperationStateHandler', () => {
  let operations: InMemoryPreviewOperationRepository;
  let secrets: InMemorySecretStore;
  let secretValues: PreviewSecretValues;
  let known: string[];
  let handler: ReportPreviewOperationStateHandler;

  beforeEach(() => {
    operations = new InMemoryPreviewOperationRepository();
    secrets = new InMemorySecretStore();
    known = [];
    secretValues = { forOperation: () => Promise.resolve(known) };
    handler = new ReportPreviewOperationStateHandler(operations, secretValues, secrets, {
      now: () => T1,
    });
  });

  async function claimed() {
    await operations.add(
      PreviewOperation.requestOther({ id: ID, projectId: PROJECT, kind: 'state', now: T0 }),
    );
    await operations.claimNext(CONTROLLER, T0);
  }

  /** A claimed build that holds an Environment file snapshot; returns its secret reference. */
  async function claimedBuildWithSnapshot(): Promise<string> {
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
    const secretId = await secrets.put('DB=test-only-pw', {
      owner: PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER,
    });
    await operations.change(ID, (held) => {
      held.recordEnvironmentFile(CONTROLLER, { path: '.env', secretId });
    });
    return secretId;
  }

  const report = (input: Partial<Parameters<ReportPreviewOperationStateHandler['execute']>[0]>) =>
    handler.execute({ operationId: ID, controllerId: CONTROLLER, state: 'in_progress', ...input });

  it('renews the lease on in_progress', async () => {
    await claimed();

    await report({ state: 'in_progress' });

    expect(await operations.find(ID)).toMatchObject({ status: 'claimed', heartbeatAt: T1 });
  });

  it('succeeds with what the controller found running', async () => {
    await claimed();

    await report({
      state: 'succeeded',
      runtime: { services: [{ name: 'web', state: 'running' }] },
    });

    const done = await operations.find(ID);
    expect(done).toMatchObject({ status: 'succeeded', finishedAt: T1 });
    expect(done?.result?.services).toEqual([{ name: 'web', state: 'running' }]);
  });

  it('fails with the failure code, the refusals and a redacted detail', async () => {
    await claimed();
    known = ['hunter2-test'];
    const refusal = {
      code: 'privileged',
      place: 'services.web',
      message: 'Privileged is refused.',
    };

    await report({
      state: 'failed',
      failure: {
        code: 'validation_refused',
        detail: 'bad: hunter2-test Authorization: Bearer abc.def',
        refusals: [refusal],
      },
    });

    const failed = await operations.find(ID);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.failure?.code).toBe('validation_refused');
    expect(failed?.failure?.detail).not.toContain('hunter2-test');
    expect(failed?.failure?.detail).not.toContain('abc.def');
    expect(failed?.failure?.refusals).toEqual([refusal]);
  });

  it.each(['succeeded', 'failed'] as const)(
    'deletes the Environment file snapshot when the operation is reported %s',
    async (state) => {
      const secretId = await claimedBuildWithSnapshot();

      await report(
        state === 'failed'
          ? { state, failure: { code: 'build_failed', detail: 'exit 1' } }
          : { state },
      );

      expect(secrets.values.has(secretId)).toBe(false);
      expect((await operations.find(ID))?.environmentFile).toBeNull();
    },
  );

  it('keeps the snapshot while the operation is in progress', async () => {
    const secretId = await claimedBuildWithSnapshot();

    await report({ state: 'in_progress' });

    expect(secrets.values.has(secretId)).toBe(true);
  });

  it('answers not found for an unknown operation', async () => {
    await expect(report({})).rejects.toBeInstanceOf(PreviewOperationNotFoundError);
  });

  it('refuses a controller that does not hold the operation', async () => {
    await claimed();

    await expect(report({ controllerId: OTHER })).rejects.toBeInstanceOf(
      PreviewOperationNotHeldError,
    );
    expect(await operations.find(ID)).toMatchObject({ status: 'claimed', heartbeatAt: T0 });
  });

  it('refuses an operation nobody claimed', async () => {
    await operations.add(
      PreviewOperation.requestOther({ id: ID, projectId: PROJECT, kind: 'state', now: T0 }),
    );

    await expect(report({})).rejects.toBeInstanceOf(PreviewOperationNotHeldError);
  });

  it('refuses a second final report: the operation is final', async () => {
    await claimed();
    await report({ state: 'succeeded' });

    await expect(report({ state: 'in_progress' })).rejects.toBeInstanceOf(
      PreviewOperationNotHeldError,
    );
    await expect(
      report({ state: 'failed', failure: { code: 'build_failed', detail: 'x' } }),
    ).rejects.toBeInstanceOf(PreviewOperationNotHeldError);
    expect(await operations.find(ID)).toMatchObject({ status: 'succeeded' });
  });
});
