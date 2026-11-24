import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { InMemoryRunEnvironmentFiles } from '../../../ports/__tests__/in-memory-run-environment-files.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../ports/preview-environment-file-snapshots.js';
import { ClaimPreviewOperationHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const NOW = new Date('2026-11-24T10:00:00.000Z');
const seconds = (count: number) => new Date(NOW.getTime() + count * 1000);
const LIMITS = PreviewLimits.of({
  memoryMiB: 1024,
  cpuPercent: 100,
  tasksMax: 512,
  buildMinutes: 20,
});

describe('ClaimPreviewOperationHandler', () => {
  let operations: InMemoryPreviewOperationRepository;
  let environmentFiles: InMemoryRunEnvironmentFiles;
  let secrets: InMemorySecretStore;
  let handler: ClaimPreviewOperationHandler;

  beforeEach(() => {
    operations = new InMemoryPreviewOperationRepository();
    environmentFiles = new InMemoryRunEnvironmentFiles();
    secrets = new InMemorySecretStore();
    handler = new ClaimPreviewOperationHandler(
      operations,
      environmentFiles,
      secrets,
      { leaseSeconds: 60, logMaxBytes: 1024 },
      { now: () => NOW },
    );
  });

  async function requestBuild(id: string, projectId = PROJECT, requested = -100) {
    await operations.add(
      PreviewOperation.requestBuild({
        id,
        projectId,
        commit: PreviewCommit.of('a'.repeat(40)),
        composeFile: PreviewComposeFile.of('compose.yaml'),
        service: PreviewService.of('web'),
        port: PreviewPort.of(3000),
        limits: LIMITS,
        now: seconds(requested),
      }),
    );
  }

  async function requestOther(
    id: string,
    kind: 'stop' | 'remove_data' | 'state',
    requested = -100,
  ) {
    await operations.add(
      PreviewOperation.requestOther({ id, projectId: PROJECT, kind, now: seconds(requested) }),
    );
  }

  const claim = () => handler.execute({ controllerId: CONTROLLER });

  it('answers null when there is nothing to do', async () => {
    await expect(claim()).resolves.toBeNull();
  });

  it('hands out the oldest requested operation to the controller, which then holds it', async () => {
    await requestOther('11111111-1111-4111-8111-111111111111', 'stop', -50);
    await requestBuild('00000000-0000-4000-8000-000000000000', OTHER_PROJECT, -100);

    const first = await claim();

    expect(first).toMatchObject({
      id: '00000000-0000-4000-8000-000000000000',
      projectId: OTHER_PROJECT,
      kind: 'build',
      previewLabel: `preview-${OTHER_PROJECT.replaceAll('-', '').slice(0, 12)}`,
      build: {
        commit: 'a'.repeat(40),
        composeFile: 'compose.yaml',
        service: 'web',
        port: 3000,
        limits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
      },
      environmentFile: null,
    });
    const held = await operations.find('00000000-0000-4000-8000-000000000000');
    expect(held).toMatchObject({ status: 'claimed', claimedBy: CONTROLLER });
  });

  it('hands out a stop, a data removal and a state with no build data', async () => {
    await requestOther('11111111-1111-4111-8111-111111111111', 'remove_data');

    await expect(claim()).resolves.toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      projectId: PROJECT,
      kind: 'remove_data',
      previewLabel: `preview-${PROJECT.replaceAll('-', '').slice(0, 12)}`,
      build: null,
      environmentFile: null,
    });
  });

  it('hands out one operation per Project at a time', async () => {
    await requestBuild('00000000-0000-4000-8000-000000000000', PROJECT, -100);
    await requestOther('11111111-1111-4111-8111-111111111111', 'stop', -50);

    expect((await claim())?.id).toBe('00000000-0000-4000-8000-000000000000');
    await expect(claim()).resolves.toBeNull();
  });

  it('gives a build the Environment file and keeps a snapshot for the operation', async () => {
    await requestBuild('00000000-0000-4000-8000-000000000000');
    environmentFiles.files.set(PROJECT, { path: '.env', content: 'DB=test-only-pw' });

    const claimed = await claim();

    expect(claimed?.environmentFile).toEqual({ path: '.env', content: 'DB=test-only-pw' });
    const held = await operations.find('00000000-0000-4000-8000-000000000000');
    expect(held?.environmentFile?.path).toBe('.env');
    const secretId = held!.environmentFile!.secretId;
    expect(secrets.values.get(secretId)).toBe('DB=test-only-pw');
    expect(secrets.owners.get(secretId)).toBe(PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER);
  });

  it('gives no Environment file to a build of a Project without one', async () => {
    await requestBuild('00000000-0000-4000-8000-000000000000');

    expect((await claim())?.environmentFile).toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  it('fails a build whose Environment file cannot be read, and hands out the next operation', async () => {
    await requestBuild('00000000-0000-4000-8000-000000000000', PROJECT, -100);
    await requestOther('11111111-1111-4111-8111-111111111111', 'state', -50);
    environmentFiles.failWith = new Error('unavailable');

    const next = await claim();

    const failed = await operations.find('00000000-0000-4000-8000-000000000000');
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.failure?.code).toBe('controller_error');
    // The same Project's state operation is handed out once the failed build no longer holds it.
    expect(next?.id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('deletes the snapshot it just stored when it cannot record it', async () => {
    await requestBuild('00000000-0000-4000-8000-000000000000');
    environmentFiles.files.set(PROJECT, { path: '.env', content: 'DB=test-only-pw' });
    const change = operations.change.bind(operations);
    let calls = 0;
    operations.change = (id, mutate) => {
      calls += 1;
      return calls === 1 ? Promise.resolve(null) : change(id, mutate);
    };

    await expect(claim()).resolves.toBeNull();

    expect(secrets.values.size).toBe(0);
  });

  it('fails an operation whose controller stopped reporting, never hands it out again, and drops its snapshot', async () => {
    await requestBuild('00000000-0000-4000-8000-000000000000');
    environmentFiles.files.set(PROJECT, { path: '.env', content: 'DB=test-only-pw' });
    await claim();
    expect(secrets.values.size).toBe(1);
    await requestOther('11111111-1111-4111-8111-111111111111', 'stop', -10);
    const later = new ClaimPreviewOperationHandler(
      operations,
      environmentFiles,
      secrets,
      { leaseSeconds: 60, logMaxBytes: 1024 },
      { now: () => seconds(120) },
    );

    const next = await later.execute({ controllerId: CONTROLLER });

    const lost = await operations.find('00000000-0000-4000-8000-000000000000');
    expect(lost).toMatchObject({ status: 'failed' });
    expect(lost?.failure?.code).toBe('controller_lost');
    expect(secrets.values.size).toBe(0);
    expect(next?.id).toBe('11111111-1111-4111-8111-111111111111');
    await expect(later.execute({ controllerId: CONTROLLER })).resolves.toBeNull();
  });

  it('keeps a held operation whose controller reported within the lease', async () => {
    await requestBuild('00000000-0000-4000-8000-000000000000');
    await claim();
    await operations.change('00000000-0000-4000-8000-000000000000', (held) => {
      held.reportProgress(CONTROLLER, seconds(-30));
    });

    await claim();

    expect(await operations.find('00000000-0000-4000-8000-000000000000')).toMatchObject({
      status: 'claimed',
    });
  });
});
