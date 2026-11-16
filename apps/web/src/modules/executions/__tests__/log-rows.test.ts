import { describe, expect, it } from 'vitest';
import type { RunEventOutput, RunStepOutput } from '../../../platform/api';
import { LogRowBuilder } from '../features/run-log/log-rows';
import { anEvent } from './fake-runs-api';

// Issue #115 (review Spec-1 of #119): the Run log's rows are built per live batch, appending
// only the new events' rows, so a long live log is not rebuilt ten times a second.

const NO_STEPS: ReadonlyMap<number, RunStepOutput> = new Map();
const NO_MESSAGES = [] as const;

const done: RunStepOutput = {
  index: 1,
  kind: 'start',
  outcome: 'done',
  summary: 'All good.',
  checks: [],
  reportedAt: '2026-11-15T10:01:00.000Z',
};

describe('LogRowBuilder', () => {
  it('appends only the new events’ rows to a growing log, keeping the earlier rows', () => {
    const builder = new LogRowBuilder();
    const events: RunEventOutput[] = [anEvent(1), anEvent(2, { text: 'two\nlines' })];

    const first = builder.build(events, NO_STEPS, NO_MESSAGES);
    events.push(anEvent(3));
    const second = builder.build(events, NO_STEPS, NO_MESSAGES);

    expect(second.map((row) => row.text)).toEqual(['line 1', 'two', 'lines', 'line 3']);
    // The earlier rows are the very same objects: nothing before the batch was rebuilt.
    first.forEach((row, i) => expect(second[i]).toBe(row));
    // Without new events, the rows are unchanged (same array).
    expect(builder.build(events, NO_STEPS, NO_MESSAGES)).toBe(second);
  });

  it('lays the rows out again when a step result arrives or the log starts over', () => {
    const builder = new LogRowBuilder();
    const events: RunEventOutput[] = [
      anEvent(1),
      anEvent(2, { kind: 'step_finished', text: 'Run step 1 finished: done' }),
    ];
    builder.build(events, NO_STEPS, NO_MESSAGES);

    const withResult = builder.build(events, new Map([[1, done]]), NO_MESSAGES);
    expect(withResult.map((row) => row.text)).toEqual([
      'line 1',
      'Run step 1 finished: done',
      'Result: done',
      'All good.',
    ]);

    // A new events array (the log was loaded again) is built from its start.
    const reloaded = builder.build([anEvent(1, { text: 'fresh' })], NO_STEPS, NO_MESSAGES);
    expect(reloaded.map((row) => row.text)).toEqual(['fresh']);
  });
});
