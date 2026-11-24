import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import { PreviewBuildNotFoundError } from '../../../../domain/errors/preview-operation-errors.js';
import { ProjectNotFoundError } from '../../../../domain/errors/preview-settings-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { PreviewCommit } from '../../../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../../../domain/value-objects/preview-limits.js';
import { PreviewLogLine } from '../../../../domain/value-objects/preview-log-line.js';
import { PreviewLogRedaction } from '../../../../domain/value-objects/preview-log-redaction.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';
import { FakePreviewSources } from '../../../ports/__tests__/fake-preview-sources.js';
import type { PreviewOperationLog } from '../../../ports/preview-operation-log.js';
import { GetPreviewBuildEventsHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const BUILD = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const STOP = '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const AT = new Date('2026-11-24T10:00:00.000Z');

/** The log port in memory: only the page read matters here. */
class StoredLog implements PreviewOperationLog {
  lines: PreviewLogLine[] = [];
  readAt: string[] = [];

  append(): never {
    throw new Error('not used');
  }

  page(operationId: string, after: number, limit: number) {
    this.readAt.push(operationId);
    const matching = this.lines.filter((line) => line.seq > after);
    return Promise.resolve({ lines: matching.slice(0, limit), hasMore: matching.length > limit });
  }
}

const line = (seq: number, text: string) =>
  PreviewLogLine.load({ seq, at: AT, stream: 'build', text }, PreviewLogRedaction.of([]));

describe('GetPreviewBuildEventsHandler', () => {
  let sources: FakePreviewSources;
  let operations: InMemoryPreviewOperationRepository;
  let log: StoredLog;
  let handler: GetPreviewBuildEventsHandler;

  beforeEach(async () => {
    sources = new FakePreviewSources();
    operations = new InMemoryPreviewOperationRepository();
    log = new StoredLog();
    handler = new GetPreviewBuildEventsHandler(sources, operations, log);
    await operations.add(
      PreviewOperation.requestBuild({
        id: BUILD,
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
        now: AT,
      }),
    );
    await operations.add(
      PreviewOperation.requestOther({ id: STOP, projectId: PROJECT, kind: 'stop', now: AT }),
    );
  });

  const page = (after = 0, limit = 2, projectId = PROJECT, buildId = BUILD) =>
    handler.execute({ projectId, buildId, after, limit });

  it('answers a page, with next while lines remain and no next on the last page', async () => {
    log.lines = [line(1, 'one'), line(2, 'two'), line(3, 'three')];

    const first = await page(0, 2);
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.next).toBe(2);

    const last = await page(first.next, 2);
    expect(last.events.map((event) => event.seq)).toEqual([3]);
    expect(last).not.toHaveProperty('next');
  });

  it('is final once the build is over, and not before', async () => {
    expect((await page()).final).toBe(false);
    await operations.change(BUILD, (op) => {
      op.claim(CONTROLLER, AT);
      op.succeed(CONTROLLER, null, AT);
    });

    expect((await page()).final).toBe(true);
  });

  it('says whether the log reached its cap', async () => {
    expect((await page()).truncated).toBe(false);
  });

  it('marks a line that holds the redaction marker', async () => {
    log.lines = [
      line(1, 'plain'),
      PreviewLogLine.restore({
        seq: 2,
        at: AT,
        stream: 'build',
        text: 'DB=••••••[redacted]',
        truncated: false,
      }),
    ];

    expect((await page()).events.map((event) => event.redacted)).toEqual([false, true]);
  });

  it('names an unknown project', async () => {
    sources.statusAnswer = { status: 'project_not_found' };

    await expect(page()).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('answers not found for an unknown id, an operation that is no build and another Project', async () => {
    await expect(
      page(0, 2, PROJECT, '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b'),
    ).rejects.toBeInstanceOf(PreviewBuildNotFoundError);
    await expect(page(0, 2, PROJECT, STOP)).rejects.toBeInstanceOf(PreviewBuildNotFoundError);
    await expect(page(0, 2, OTHER_PROJECT, BUILD)).rejects.toBeInstanceOf(
      PreviewBuildNotFoundError,
    );
    expect(log.readAt).toEqual([]);
  });
});
