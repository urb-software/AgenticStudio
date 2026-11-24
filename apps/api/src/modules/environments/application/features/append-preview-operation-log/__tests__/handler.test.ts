import { beforeEach, describe, expect, it } from 'vitest';
import { PreviewOperation } from '../../../../domain/entities/preview-operation.js';
import {
  PreviewOperationNotFoundError,
  PreviewOperationNotHeldError,
} from '../../../../domain/errors/preview-operation-errors.js';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { PreviewLogCap } from '../../../../domain/value-objects/preview-log-cap.js';
import type { PreviewLogLine } from '../../../../domain/value-objects/preview-log-line.js';
import { FakeControllerPresence } from '../../../ports/__tests__/fake-controller-presence.js';
import type { PreviewOperationLog } from '../../../ports/preview-operation-log.js';
import { AppendPreviewOperationLogHandler } from '../handler.js';

const ID = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OTHER = '11111111-2222-4333-8444-555555555555';
const AT = new Date('2026-11-24T10:00:00.000Z');

/** The log port in memory: the cap and the duplicate filter are the domain's, the holder check the operation's. */
class InMemoryPreviewOperationLog implements PreviewOperationLog {
  readonly stored = new Map<number, PreviewLogLine>();
  private state = { bytes: 0, truncated: false };

  constructor(private readonly operations: InMemoryPreviewOperationRepository) {}

  async append(
    operationId: string,
    controllerId: string,
    lines: readonly PreviewLogLine[],
    maxBytes: number,
  ) {
    const operation = await this.operations.find(operationId);
    if (operation?.status !== 'claimed' || operation.claimedBy !== controllerId) return null;
    const fresh = lines.filter((line) => !this.stored.has(line.seq));
    const plan = PreviewLogCap.of(this.state).plan(fresh, maxBytes);
    for (const line of plan.store) this.stored.set(line.seq, line);
    this.state = plan.state;
    return { stored: plan.store.length, truncated: plan.state.truncated };
  }

  page(_operationId: string, after: number, limit: number) {
    const lines = [...this.stored.values()]
      .filter((line) => line.seq > after)
      .sort((a, b) => a.seq - b.seq);
    return Promise.resolve({ lines: lines.slice(0, limit), hasMore: lines.length > limit });
  }
}

describe('AppendPreviewOperationLogHandler', () => {
  let operations: InMemoryPreviewOperationRepository;
  let log: InMemoryPreviewOperationLog;
  let known: string[];
  let presence: FakeControllerPresence;
  let handler: AppendPreviewOperationLogHandler;

  beforeEach(async () => {
    operations = new InMemoryPreviewOperationRepository();
    log = new InMemoryPreviewOperationLog(operations);
    known = [];
    presence = new FakeControllerPresence(AT);
    handler = new AppendPreviewOperationLogHandler(
      operations,
      log,
      { forOperation: () => Promise.resolve(known) },
      { leaseSeconds: 60, logMaxBytes: 100, snapshotGraceMs: 3_600_000, unclaimedMinutes: 5 },
      { now: () => AT },
      presence,
    );
    await operations.add(
      PreviewOperation.requestOther({ id: ID, projectId: PROJECT, kind: 'state', now: AT }),
    );
    await operations.claimNext(CONTROLLER, AT);
  });

  const line = (seq: number, text: string, truncated?: boolean) => ({
    seq,
    at: AT,
    stream: 'build' as const,
    text,
    ...(truncated === undefined ? {} : { truncated }),
  });
  const append = (lines: ReturnType<typeof line>[], controllerId = CONTROLLER) =>
    handler.execute({ operationId: ID, controllerId, lines });

  it('stores the lines and says how many', async () => {
    await expect(append([line(1, 'step 1/3'), line(2, 'step 2/3')])).resolves.toEqual({
      stored: 2,
      truncated: false,
    });
    expect([...log.stored.values()].map((stored) => stored.text)).toEqual(['step 1/3', 'step 2/3']);
  });

  it('redacts the Environment file values and token shapes before storing', async () => {
    known = ['hunter2-test'];

    await append([line(1, 'DB=hunter2-test'), line(2, 'Authorization: Bearer abc.def')]);

    const text = [...log.stored.values()].map((stored) => stored.text).join('\n');
    expect(text).not.toContain('hunter2-test');
    expect(text).not.toContain('abc.def');
  });

  it('cuts a line to its byte size and marks it', async () => {
    const roomy = new AppendPreviewOperationLogHandler(
      operations,
      log,
      { forOperation: () => Promise.resolve(known) },
      { leaseSeconds: 60, logMaxBytes: 100_000, snapshotGraceMs: 3_600_000, unclaimedMinutes: 5 },
      { now: () => AT },
      presence,
    );

    await roomy.execute({
      operationId: ID,
      controllerId: CONTROLLER,
      lines: [line(1, 'x'.repeat(5000))],
    });

    expect(new TextEncoder().encode(log.stored.get(1)!.text).length).toBeLessThanOrEqual(2048);
    expect(log.stored.get(1)!.truncated).toBe(true);
  });

  it('ignores a line whose seq is already stored, so a re-sent batch is idempotent', async () => {
    await append([line(1, 'first'), line(2, 'second')]);

    await expect(
      append([line(1, 'changed'), line(2, 'changed'), line(3, 'third')]),
    ).resolves.toEqual({ stored: 1, truncated: false });
    expect(log.stored.get(1)!.text).toBe('first');
    expect(log.stored.get(3)!.text).toBe('third');
  });

  it('stores one notice at the cap, drops later lines and says truncated', async () => {
    await append([line(1, 'x'.repeat(90))]);

    await expect(append([line(2, 'y'.repeat(50)), line(3, 'z')])).resolves.toEqual({
      stored: 1,
      truncated: true,
    });
    expect(log.stored.get(2)!.text).toContain('log truncated');
    await expect(append([line(4, 'later')])).resolves.toEqual({ stored: 0, truncated: true });
    expect(log.stored.has(3)).toBe(false);
    expect(log.stored.has(4)).toBe(false);
  });

  it('answers not found for an unknown operation', async () => {
    await expect(
      handler.execute({
        operationId: '99999999-9999-4999-8999-999999999999',
        controllerId: CONTROLLER,
        lines: [line(1, 'x')],
      }),
    ).rejects.toBeInstanceOf(PreviewOperationNotFoundError);
  });

  it('refuses a controller that does not hold the operation', async () => {
    await expect(append([line(1, 'x')], OTHER)).rejects.toBeInstanceOf(
      PreviewOperationNotHeldError,
    );
    expect(log.stored.size).toBe(0);
  });

  it('refuses lines for a final operation', async () => {
    await operations.change(ID, (held) => {
      held.succeed(CONTROLLER, null, AT);
    });

    await expect(append([line(1, 'x')])).rejects.toBeInstanceOf(PreviewOperationNotHeldError);
  });

  it('records that a controller called', async () => {
    await append([line(1, 'step 1/3')]);

    expect(presence.recorded).toEqual([AT]);
  });
});
