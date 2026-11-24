import { PREVIEW_ARCHIVE_MAX_BYTES } from '@agentic-studio/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import {
  PreviewOperationNotABuildError,
  PreviewOperationNotFoundError,
  PreviewOperationNotHeldError,
} from '../../../../domain/errors/preview-operation-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { PreviewArchiveLimit } from '../../../../domain/value-objects/preview-archive-limit.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import { GetPreviewOperationSourceHandler } from '../handler.js';

const ID = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OTHER = '11111111-2222-4333-8444-555555555555';
const T0 = new Date('2026-11-24T10:00:00.000Z');
const COMMIT = 'a'.repeat(40);

describe('GetPreviewOperationSourceHandler', () => {
  let operations: InMemoryPreviewOperationRepository;
  let sources: FakePreviewSources;
  let handler: GetPreviewOperationSourceHandler;

  beforeEach(() => {
    operations = new InMemoryPreviewOperationRepository();
    sources = new FakePreviewSources();
    handler = new GetPreviewOperationSourceHandler(operations, sources);
  });

  async function claimBuild() {
    await operations.add(
      PreviewOperation.requestBuild({
        id: ID,
        projectId: PROJECT,
        commit: PreviewCommit.of(COMMIT),
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
  }

  const source = (controllerId = CONTROLLER) => handler.execute({ operationId: ID, controllerId });

  it('has the same archive limit as the controller protocol', () => {
    expect(PreviewArchiveLimit.MAX_BYTES).toBe(PREVIEW_ARCHIVE_MAX_BYTES);
  });

  it('opens the archive of the build commit under the limit', async () => {
    await claimBuild();
    const close = vi.fn(() => Promise.resolve());
    sources.archiveAnswer = {
      status: 'ready',
      sizeBytes: 12,
      chunks: (async function* () {})(),
      close,
    };

    const result = await source();

    expect(sources.openArchive).toHaveBeenCalledWith(PROJECT, COMMIT, PREVIEW_ARCHIVE_MAX_BYTES);
    expect(result).toMatchObject({ status: 'ready', sizeBytes: 12 });
  });

  it('answers too large for an archive over the limit', async () => {
    await claimBuild();
    sources.archiveAnswer = { status: 'too_large' };

    await expect(source()).resolves.toEqual({ status: 'source_too_large' });
  });

  it.each(['commit_missing', 'repository_not_ready', 'unsupported_platform', 'failed'] as const)(
    'answers unavailable when the archive is %s',
    async (status) => {
      await claimBuild();
      sources.archiveAnswer = { status };

      await expect(source()).resolves.toEqual({ status: 'source_unavailable' });
    },
  );

  it('answers not found for an unknown operation', async () => {
    await expect(source()).rejects.toBeInstanceOf(PreviewOperationNotFoundError);
  });

  it('refuses a controller that does not hold the operation, and one nobody claimed', async () => {
    await claimBuild();
    await expect(source(OTHER)).rejects.toBeInstanceOf(PreviewOperationNotHeldError);
    await operations.change(ID, (held) => {
      held.succeed(CONTROLLER, null, T0);
    });
    await expect(source()).rejects.toBeInstanceOf(PreviewOperationNotHeldError);
    expect(sources.openArchive).not.toHaveBeenCalled();
  });

  it('refuses an operation that is not a build', async () => {
    await operations.add(
      PreviewOperation.requestOther({ id: ID, projectId: PROJECT, kind: 'stop', now: T0 }),
    );
    await operations.claimNext(CONTROLLER, T0);

    await expect(source()).rejects.toBeInstanceOf(PreviewOperationNotABuildError);
  });
});
