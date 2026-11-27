import { runPayloadSchema, type RunPayload } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { agentFields } from './agent-fixtures.js';

const START = {
  runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a11',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  ...agentFields('codex'),
  task: 'Add a health check',
  startCommit: 'a'.repeat(40),
  repository: { remoteUrl: 'https://git.example.test/acme/shop.git' },
  integrationBranch: 'dev',
  kind: 'start',
  studioPaths: [],
  limits: { stepMinutes: 60, maxSteps: 10 },
  completedSteps: 0,
} satisfies Record<string, unknown>;

const NEXT = {
  ...START,
  kind: 'next_phase',
  runBranch: 'agent/x',
  nextSeq: 4,
  completedSteps: 1,
  phase: {
    position: 1,
    itemId: 'polish',
    count: 2,
    final: true,
    previous: { itemId: 'build', agent: 'builder', summary: 'Built it.' },
  },
} satisfies Record<string, unknown>;

const parses = (payload: Record<string, unknown>) => runPayloadSchema.safeParse(payload).success;

describe('the claim of a Run with Phases', () => {
  it('is, for a Run started with an agent, a claim with no Phase', () => {
    const parsed = runPayloadSchema.parse(START) satisfies RunPayload;

    expect(parsed).not.toHaveProperty('phase');
  });

  it('carries the Phase of a start, with what follows it', () => {
    expect(
      parses({ ...START, phase: { position: 0, itemId: 'build', count: 2, final: false } }),
    ).toBe(true);
  });

  it('is a next-Phase claim with the kept branch, the next seq and the Phase', () => {
    expect(parses(NEXT)).toBe(true);
  });

  it('carries what the operator wrote at the Checkpoint before the Phase, also for the first Phase', () => {
    const first = { position: 0, itemId: 'build', count: 2, final: false };

    expect(parses({ ...START, phase: { ...first, checkpointComment: 'Take care.' } })).toBe(true);
    expect(
      parses({ ...NEXT, phase: { ...NEXT.phase, checkpointComment: 'x'.repeat(20_000) } }),
    ).toBe(true);
    expect(
      parses({ ...NEXT, phase: { ...NEXT.phase, checkpointComment: 'x'.repeat(20_001) } }),
    ).toBe(false);
    expect(parses({ ...NEXT, phase: { ...NEXT.phase, checkpointComment: '' } })).toBe(false);
  });

  it.each([
    ['has no Phase', { phase: undefined }],
    ['has no Run branch', { runBranch: undefined }],
    ['has no next seq', { nextSeq: undefined }],
    ['resumes a session without its answer', { sessionRef: 's-1', resumeReason: 'follow_up' }],
    ['has a Phase beyond the count', { phase: { ...NEXT.phase, position: 2 } }],
    ['carries an Environment file', { environmentFile: { path: '.env', content: 'A=1' } }],
  ])('refuses a next-Phase claim that %s', (_case, change) => {
    expect(parses({ ...NEXT, ...change })).toBe(false);
  });

  it('resumes the session a Phase had in an earlier round with the Follow-up text', () => {
    expect(
      parses({
        ...NEXT,
        sessionRef: 's-1',
        answer: 'Add a test too.',
        resumeReason: 'follow_up',
        followUpNumber: 1,
      }),
    ).toBe(true);
  });

  it('refuses a delivery claim that carries a Phase', () => {
    expect(
      parses({
        ...START,
        kind: 'deliver',
        runBranch: 'agent/x',
        nextSeq: 4,
        phase: NEXT.phase,
      }),
    ).toBe(false);
  });

  it('bounds the instructions of a Phase to the Workflow format limit', () => {
    expect(parses({ ...NEXT, phase: { ...NEXT.phase, instructions: 'x'.repeat(2049) } })).toBe(
      false,
    );
    expect(parses({ ...NEXT, phase: { ...NEXT.phase, instructions: 'x'.repeat(2048) } })).toBe(
      true,
    );
  });
});
