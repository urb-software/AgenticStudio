import { CONTROLLER_PROBLEM_TYPES } from '@agentic-studio/contracts';
import {
  CONTROLLER_REPORTABLE_FAILURE_CODES,
  PREVIEW_LIMIT_BOUNDS,
  PREVIEW_LOG_LINE_MAX_BYTES,
  PREVIEW_LOG_STREAMS as PROTOCOL_LOG_STREAMS,
  PREVIEW_OPERATION_FAILURE_CODES,
  PREVIEW_OPERATION_KINDS as PROTOCOL_KINDS,
  PREVIEW_RUNTIME_SERVICES_MAX,
  PREVIEW_FAILURE_DETAIL_MAX_LENGTH,
  PREVIEW_FAILURE_REFUSALS_MAX,
} from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { InvalidPreviewCommitError, PreviewCommit } from '../preview-commit.js';
import { PREVIEW_FAILURE_CODES } from '../preview-failure-code.js';
import { InvalidPreviewLimitsError, PreviewLimits } from '../preview-limits.js';
import { PREVIEW_LOG_STREAMS, PreviewLogLine } from '../preview-log-line.js';
import { PREVIEW_LOG_TRUNCATED_NOTICE, PreviewLogCap } from '../preview-log-cap.js';
import { PreviewLogRedaction } from '../preview-log-redaction.js';
import { PREVIEW_OPERATION_KINDS } from '../preview-operation-kind.js';
import { PreviewOperationFailure } from '../preview-operation-failure.js';
import { PreviewOperationResult } from '../preview-operation-result.js';

const AT = new Date('2026-11-24T10:00:00.000Z');
const NONE = PreviewLogRedaction.of([]);

const line = (seq: number, text: string) =>
  PreviewLogLine.load({ seq, at: AT, stream: 'build', text }, NONE);

describe('the lists pinned to the controller protocol', () => {
  it('has the same operation kinds, failure codes and log streams', () => {
    expect([...PREVIEW_OPERATION_KINDS]).toEqual([...PROTOCOL_KINDS]);
    expect([...PREVIEW_FAILURE_CODES].sort()).toEqual([...PREVIEW_OPERATION_FAILURE_CODES].sort());
    expect([...PREVIEW_LOG_STREAMS]).toEqual([...PROTOCOL_LOG_STREAMS]);
    expect(PREVIEW_FAILURE_CODES.filter((code) => code !== 'controller_lost').sort()).toEqual(
      [...CONTROLLER_REPORTABLE_FAILURE_CODES].sort(),
    );
  });

  it('has the same limits and bounds', () => {
    expect(PreviewLimits.BOUNDS).toEqual(PREVIEW_LIMIT_BOUNDS);
    expect(PreviewLogLine.TEXT_MAX_BYTES).toBe(PREVIEW_LOG_LINE_MAX_BYTES);
    expect(PreviewOperationFailure.DETAIL_MAX_LENGTH).toBe(PREVIEW_FAILURE_DETAIL_MAX_LENGTH);
    expect(PreviewOperationFailure.REFUSALS_MAX).toBe(PREVIEW_FAILURE_REFUSALS_MAX);
    expect(PreviewOperationResult.SERVICES_MAX).toBe(PREVIEW_RUNTIME_SERVICES_MAX);
  });

  it('has the four problem types the controller reacts to', () => {
    expect(Object.values(CONTROLLER_PROBLEM_TYPES).every((type) => type.startsWith('urn:'))).toBe(
      true,
    );
  });
});

describe('PreviewCommit', () => {
  it('takes a full lower-case commit id only', () => {
    expect(PreviewCommit.of('a'.repeat(40)).value).toBe('a'.repeat(40));
    for (const bad of [
      '',
      'HEAD',
      'a'.repeat(39),
      'A'.repeat(40),
      'g'.repeat(40),
      'a'.repeat(64),
    ]) {
      expect(() => PreviewCommit.of(bad)).toThrow(InvalidPreviewCommitError);
    }
  });
});

describe('PreviewLimits', () => {
  const ok = { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 };

  it('takes limits inside the bounds and gives them back', () => {
    expect(PreviewLimits.of(ok).toData()).toEqual(ok);
    expect(
      PreviewLimits.of({ memoryMiB: 128, cpuPercent: 10, tasksMax: 64, buildMinutes: 1 }),
    ).toBeDefined();
    expect(
      PreviewLimits.of({
        memoryMiB: 65_536,
        cpuPercent: 6400,
        tasksMax: 32_768,
        buildMinutes: 120,
      }),
    ).toBeDefined();
  });

  it.each([
    ['memoryMiB', 127],
    ['memoryMiB', 65_537],
    ['cpuPercent', 9],
    ['cpuPercent', 6401],
    ['tasksMax', 63],
    ['tasksMax', 32_769],
    ['buildMinutes', 0],
    ['buildMinutes', 121],
    ['memoryMiB', 1.5],
  ])('refuses %s of %d', (name, value) => {
    expect(() => PreviewLimits.of({ ...ok, [name]: value })).toThrow(InvalidPreviewLimitsError);
  });
});

describe('PreviewOperationFailure', () => {
  it('cuts the detail and the refusals', () => {
    const refusal = { code: 'privileged', place: 'services.web', message: 'No.' };
    const failure = PreviewOperationFailure.of(
      'validation_refused',
      'x'.repeat(3000),
      Array.from({ length: 150 }, () => refusal),
    );

    expect(failure.detail).toHaveLength(2000);
    expect(failure.refusals).toHaveLength(100);
  });

  it('is restored from what it gives', () => {
    const failure = PreviewOperationFailure.of('build_failed', 'exit 1');
    expect(PreviewOperationFailure.restore(failure.toData()).toData()).toEqual(failure.toData());
  });
});

describe('PreviewOperationResult', () => {
  it('keeps at most 100 services', () => {
    const services = Array.from({ length: 120 }, (_, i) => ({ name: `s${i}`, state: 'running' }));
    expect(PreviewOperationResult.of(services).services).toHaveLength(100);
  });
});

describe('PreviewLogLine', () => {
  it('redacts the Environment file values and token shapes before it cuts', () => {
    const redaction = PreviewLogRedaction.of(['hunter2-test']);
    const stored = PreviewLogLine.load(
      {
        seq: 1,
        at: AT,
        stream: 'start',
        text: 'DB=hunter2-test and Authorization: Bearer abc.def',
      },
      redaction,
    );

    expect(stored.text).not.toContain('hunter2-test');
    expect(stored.text).not.toContain('abc.def');
    expect(stored.text).toContain('[redacted]');
  });

  it('cuts a text to 2048 bytes at a character boundary and marks it truncated', () => {
    const stored = line(1, 'é'.repeat(2000));

    expect(new TextEncoder().encode(stored.text).length).toBeLessThanOrEqual(2048);
    expect(stored.text).toBe('é'.repeat(1024));
    expect(stored.truncated).toBe(true);
  });

  it('keeps a short text whole and the controller truncated mark', () => {
    expect(line(1, 'step 1/3')).toMatchObject({ text: 'step 1/3', truncated: false });
    expect(
      PreviewLogLine.load(
        { seq: 1, at: AT, stream: 'build', text: 'cut by the controller', truncated: true },
        NONE,
      ).truncated,
    ).toBe(true);
  });

  it('cuts after redaction, so a secret is not split open', () => {
    const secret = 'S3cr3t-value-0123456789';
    const text = `${'x'.repeat(2040)}${secret}`;
    const stored = PreviewLogLine.load(
      { seq: 1, at: AT, stream: 'build', text },
      PreviewLogRedaction.of([secret]),
    );

    expect(stored.text).not.toContain('S3cr3t');
  });
});

describe('PreviewLogCap', () => {
  it('stores the lines that fit and counts their bytes', () => {
    const plan = PreviewLogCap.of({ bytes: 0, truncated: false }).plan(
      [line(1, 'aaaa'), line(2, 'bbbb')],
      100,
    );

    expect(plan.store.map((stored) => stored.seq)).toEqual([1, 2]);
    expect(plan.state).toEqual({ bytes: 8, truncated: false });
  });

  it('turns the first line that does not fit into one notice and drops the rest', () => {
    const plan = PreviewLogCap.of({ bytes: 6, truncated: false }).plan(
      [line(3, 'aaaa'), line(4, 'bbbb')],
      8,
    );

    expect(plan.store).toHaveLength(1);
    expect(plan.store[0]).toMatchObject({
      seq: 3,
      stream: 'controller',
      text: PREVIEW_LOG_TRUNCATED_NOTICE,
    });
    expect(plan.state).toEqual({ bytes: 6, truncated: true });
  });

  it('stores nothing once truncated', () => {
    const plan = PreviewLogCap.of({ bytes: 6, truncated: true }).plan([line(5, 'a')], 1000);

    expect(plan.store).toEqual([]);
    expect(plan.state.truncated).toBe(true);
  });
});
