import { describe, expect, it } from 'vitest';
import {
  AGENT_RESULT_JSON_SCHEMA,
  REVIEW_RESULT_JSON_SCHEMA,
  reviewResultSchema,
} from '../agent-definition/index.js';
import { ClaudeStream } from '../claude-code/stream.js';
import {
  CODEX_RESULT_JSON_SCHEMA,
  CODEX_REVIEW_RESULT_JSON_SCHEMA,
} from '../codex/result-schema.js';
import { CodexStream } from '../codex/stream.js';
import { AgentFailedError } from '../runner.js';

// The result of a review Phase carries a Verdict, validated before it leaves the worker; a result
// that has none, or an invalid one, ends the step as failed with a reason that names the Verdict.

const OK = { exitCode: 0, spawnFailed: false };
const REVIEW = { kind: 'review' as const };
const SESSION = 'session-1';

const CHANGES = {
  outcome: 'done',
  summary: 'Asks for changes.',
  verdict: 'changes_requested',
  findings: [{ text: 'Wrong.', file: 'src/a.ts', line: 3 }, { text: 'Also.' }],
};

/** What the Claude Code CLI ends a step with, around the structured output. */
function claudeEnd(structured: unknown, phase?: { kind: 'work' | 'review' }) {
  const stream = new ClaudeStream(phase);
  stream.accept(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      tools: [],
      model: 'm',
    }),
  );
  stream.accept(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      session_id: SESSION,
      structured_output: structured,
    }),
  );
  return stream.finish(OK);
}

/** What a Codex step ends with: a completed turn and the result file. */
function codexEnd(structured: unknown, phase?: { kind: 'work' | 'review' }) {
  const stream = new CodexStream(undefined, phase);
  stream.accept(JSON.stringify({ type: 'thread.started', thread_id: SESSION }));
  stream.accept(JSON.stringify({ type: 'turn.completed', usage: {} }));
  return stream.finish(OK, { kind: 'file', text: JSON.stringify(structured) });
}

const ENDS = [
  ['Claude Code', claudeEnd],
  ['Codex', codexEnd],
] as const;

describe.each(ENDS)('the result of a %s review step', (_name, end) => {
  it('is the Verdict and the findings, with the session from the stream', () => {
    const outcome = end(CHANGES, REVIEW);

    expect(outcome).toMatchObject({
      result: { ...CHANGES, sessionRef: SESSION },
      events: [],
    });
  });

  it('accepts an approval with or without findings', () => {
    for (const result of [
      { outcome: 'done', summary: 'Fine.', verdict: 'approved' },
      { outcome: 'done', summary: 'Fine.', verdict: 'approved', findings: [{ text: 'A nit.' }] },
    ]) {
      expect(end(result, REVIEW)).toMatchObject({ result });
    }
  });

  it.each([
    ['without a Verdict', { outcome: 'done', summary: 'Forgot.' }],
    ['with an unknown Verdict', { outcome: 'done', summary: 'x', verdict: 'maybe' }],
    [
      'with changes requested and no finding',
      { outcome: 'done', summary: 'x', verdict: 'changes_requested' },
    ],
    [
      'with changes requested and an empty list',
      { outcome: 'done', summary: 'x', verdict: 'changes_requested', findings: [] },
    ],
    [
      'with a finding that is too long',
      {
        outcome: 'done',
        summary: 'x',
        verdict: 'changes_requested',
        findings: [{ text: 'x'.repeat(2001) }],
      },
    ],
    [
      'with a line that is not positive',
      {
        outcome: 'done',
        summary: 'x',
        verdict: 'changes_requested',
        findings: [{ text: 'x', line: 0 }],
      },
    ],
  ])('fails the step, naming the Verdict, for a result %s', (_case, structured) => {
    const outcome = end(structured, REVIEW);

    expect('error' in outcome && outcome.error).toBeInstanceOf(AgentFailedError);
    expect('error' in outcome && outcome.error.message).toMatch(/review without a valid .*Verdict/);
  });

  it('lets a review ask a question, which has no Verdict', () => {
    const asking = {
      outcome: 'needs_input',
      summary: 'Stuck.',
      question: { text: 'Which?' },
    };

    expect(end(asking, REVIEW)).toMatchObject({ result: { outcome: 'needs_input' } });
    expect('error' in end({ ...asking, verdict: 'approved' }, REVIEW)).toBe(true);
  });

  it('refuses the Verdict of a work step, which is not allowed one', () => {
    const outcome = end({ outcome: 'done', summary: 'x', verdict: 'approved' });

    expect('error' in outcome).toBe(true);
    expect('error' in outcome && outcome.error.message).not.toMatch(/Verdict/);
  });
});

describe('the schemas the CLIs are given', () => {
  it('give a work step no Verdict, byte for byte what they always gave', () => {
    expect(AGENT_RESULT_JSON_SCHEMA).not.toContain('verdict');
    expect(CODEX_RESULT_JSON_SCHEMA).not.toContain('verdict');
  });

  it('give a review step the Verdict and the findings, in draft-07 words without a draft name', () => {
    for (const text of [REVIEW_RESULT_JSON_SCHEMA, CODEX_REVIEW_RESULT_JSON_SCHEMA]) {
      expect(text).toContain('"verdict"');
      expect(text).toContain('"changes_requested"');
      expect(text).toContain('"findings"');
      expect(text).not.toContain('2020-12');
      expect(text).not.toContain('$schema');
    }
    const strict = JSON.parse(CODEX_REVIEW_RESULT_JSON_SCHEMA) as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(expect.arrayContaining(['verdict', 'findings']));
  });

  it('say the same as the worker checks: a Verdict is needed for done, findings for changes', () => {
    expect(reviewResultSchema.safeParse(CHANGES).success).toBe(true);
    expect(reviewResultSchema.safeParse({ outcome: 'done', summary: 'x' }).success).toBe(false);
  });
});
