import { describe, expect, it } from 'vitest';
import { runResponseSchema, toRunListItem, toRunResponse } from '../run-response.js';

// Issue #103: the conversation and the open question in the operator API.
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:05:00.000Z');
const T2 = new Date('2026-11-15T12:10:00.000Z');
const QUESTION = {
  text: 'Which database?',
  options: ['PostgreSQL', 'SQLite'],
  recommendation: 'PostgreSQL',
};

const run = {
  id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex' as const,
  task: 'Add a store',
  state: 'waiting_for_operator' as const,
  startCommit: 'a'.repeat(40),
  createdAt: T0,
  startedAt: T0,
  finishedAt: null,
  failure: null,
  workingCopy: null,
  limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14 },
  cancelRequestedAt: null,
  cancellation: null,
  delivery: null,
  pullRequest: null,
  deliveryRequested: false,
  failingChecks: [],
  environmentFileSupplied: false,
  messages: [{ kind: 'question' as const, question: QUESTION, at: T1 }],
};

describe('Run response: conversation (Issue #103)', () => {
  it('shows the open question of a waiting Run, with its options and recommendation', () => {
    const response = runResponseSchema.parse(toRunResponse(run));

    expect(response.question).toEqual(QUESTION);
    expect(response.messages).toEqual([
      { role: 'operator', kind: 'task', text: 'Add a store', at: T0.toISOString() },
      { role: 'agent', kind: 'question', text: 'Which database?', at: T1.toISOString() },
    ]);
  });

  it('lists the answer after its question, and no open question once answered', () => {
    const response = toRunResponse({
      ...run,
      state: 'queued',
      messages: [...run.messages, { kind: 'answer', text: 'PostgreSQL', at: T2 }],
    });

    expect(response.question).toBeUndefined();
    expect(response.messages?.map(({ role, kind, text }) => [role, kind, text])).toEqual([
      ['operator', 'task', 'Add a store'],
      ['agent', 'question', 'Which database?'],
      ['operator', 'answer', 'PostgreSQL'],
    ]);
  });

  it('leaves the conversation and the open question out of list items (coordinator decision)', () => {
    const item = toRunListItem(run);

    expect(item).not.toHaveProperty('messages');
    expect(item).not.toHaveProperty('question');
    expect(item).toMatchObject({ id: run.id, state: 'waiting_for_operator' });
  });

  it('has no open question outside waiting, and the Task alone before any question', () => {
    expect(toRunResponse({ ...run, state: 'cancelled' }).question).toBeUndefined();
    expect(toRunResponse({ ...run, state: 'running', messages: [] }).messages).toEqual([
      { role: 'operator', kind: 'task', text: 'Add a store', at: T0.toISOString() },
    ]);
  });
});
