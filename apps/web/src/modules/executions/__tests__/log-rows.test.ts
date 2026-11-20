import { describe, expect, it } from 'vitest';
import type { RunEventOutput, RunStepOutput } from '../../../platform/api';
import { LogRowBuilder, stepStartRowKey } from '../features/run-log/log-rows';
import { anEvent } from './fake-runs-api';

// The Run log's rows are built per live batch, appending only the new events' rows, so a long
// live log is not rebuilt ten times a second.

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

  // After a usage-limit resume the worker runs the cut step again under the same number, and the
  // resume text is stored as an operator answer.
  const at = '2026-11-15T10:00:00.000Z';
  const needsInput: RunStepOutput = { ...done, outcome: 'needs_input', summary: 'Which DB?' };
  const resumedLog: RunEventOutput[] = [
    anEvent(1, { kind: 'step_started', text: 'Run step 1 started' }),
    anEvent(2, { kind: 'step_finished', text: 'Run step 1 finished: needs input' }),
    anEvent(3, { kind: 'step_started', stepIndex: 2, text: 'Run step 2 started' }),
    anEvent(4, { stepIndex: 2, text: 'usage limit reached' }),
    anEvent(5, { kind: 'step_started', stepIndex: 2, text: 'Run step 2 started' }),
    anEvent(6, { stepIndex: 2, text: 'carrying on' }),
  ];
  const resumedMessages = [
    { role: 'operator', kind: 'task', text: 'Add a store', at },
    { role: 'agent', kind: 'question', text: 'Which database?', at },
    { role: 'operator', kind: 'answer', text: 'PostgreSQL', at },
    { role: 'operator', kind: 'answer', text: 'Continue where you stopped.', at },
  ] as const;

  it('points a step at its latest attempt when the step ran again after a resume', () => {
    expect(stepStartRowKey(resumedLog, 2)).toBe('5:0');
    expect(stepStartRowKey(resumedLog, 1)).toBe('1:0');
    expect(stepStartRowKey(resumedLog, 3)).toBeUndefined();
  });

  it('keeps the real answer with its question and shows the resume as its own row', () => {
    const rows = new LogRowBuilder().build(resumedLog, new Map([[1, needsInput]]), resumedMessages);

    expect(rows.map((row) => row.text)).toEqual([
      'Run step 1 started',
      'Run step 1 finished: needs input',
      'Result: needs input',
      'Which DB?',
      'Question: Which database?',
      'Answer: PostgreSQL',
      'Run step 2 started',
      'usage limit reached',
      'Resumed: Continue where you stopped.',
      'Run step 2 started',
      'carrying on',
    ]);
  });
});
