import type { RunnerEvent } from '@agentic-studio/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClaudeStream, type ProcessEnd, type StepOutcome } from '../claude-code/stream.js';
import { AgentFailedError, UsageLimitError } from '../runner.js';

// Issue #105: mapping the CLI's stream-json output to Run events and the structured result,
// against the recorded streams the stub executable replays (shaped like CLI 2.1.325's).

const SESSION = '8f14e45f-ceea-4c8b-9f2e-1f5a7b3c9d20';
const recording = (name: string) =>
  readFileSync(new URL(`./fixtures/claude-recordings/${name}.ndjson`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '');

function replay(name: string, end: ProcessEnd = { exitCode: 0, spawnFailed: false }) {
  const stream = new ClaudeStream();
  const events: RunnerEvent[] = recording(name).flatMap((line) => stream.accept(line));
  const outcome: StepOutcome = stream.finish(end);
  return { events, outcome, stream };
}

const failed = (outcome: StepOutcome) => {
  if (!('error' in outcome)) throw new Error('expected a failure');
  return outcome;
};

describe('the Claude Code event stream', () => {
  it('maps text, Bash commands and tool results, and ends with the structured result and session', () => {
    const { events, outcome, stream } = replay('success');

    expect(events).toEqual([
      { type: 'message', text: "I'll add the health check." },
      { type: 'command', text: 'npm test -- --run' },
      { type: 'output', text: 'Tests: 3 passed' },
      { type: 'output', text: 'The file was updated.' },
      { type: 'message', text: 'Done: GET /health is in place.' },
    ]);
    expect(stream.sessionRef).toBe(SESSION);
    expect(outcome).toEqual({
      events: [],
      result: {
        outcome: 'done',
        summary: 'Added GET /health with a test.',
        pullRequest: {
          title: 'Add a health check',
          body: 'Adds GET /health.\n\nAssumptions: none.',
        },
        checks: [{ name: 'unit tests', result: 'passed', detail: '3 passed' }],
        sessionRef: SESSION,
      },
    });
  });

  it('ends a question with needs_input and the session its answer resumes', () => {
    const { outcome } = replay('question');

    expect('result' in outcome && outcome.result).toEqual({
      outcome: 'needs_input',
      summary: 'The Task does not say which database to use.',
      question: {
        text: 'Which database should the store use?',
        options: ['PostgreSQL', 'SQLite'],
        recommendation: 'PostgreSQL',
      },
      sessionRef: SESSION,
    });
  });

  it('ignores unknown event types and lines that are not JSON', () => {
    const { events, outcome } = replay('unknown-events');

    expect(events).toEqual([{ type: 'message', text: 'Still fine.' }]);
    expect('result' in outcome && outcome.result.summary).toBe('Done despite unknown events.');
  });

  it('logs a denied tool call as a notice and does not fail the step for it', () => {
    const { events, outcome } = replay('permission-denied');

    expect(events).toContainEqual({
      type: 'notice',
      text: 'A tool call was denied by the permission rules (Bash); the agent goes on.',
    });
    expect(events).toContainEqual({ type: 'command', text: 'git push origin HEAD' });
    expect('result' in outcome && outcome.result.outcome).toBe('done');
  });

  it.each(['invalid-result', 'no-structured-output'])(
    'fails a step without a valid structured result as agent_failed, with the raw final text (%s)',
    (name) => {
      const { outcome } = replay(name);

      const { error, events } = failed(outcome);
      expect(error).toBeInstanceOf(AgentFailedError);
      expect(error.message).toBe(
        'Claude Code ended without a valid structured result. Its final text is in the log.',
      );
      expect(events[0]).toEqual({
        type: 'notice',
        text: "Claude Code's final text follows (its structured result was missing or not valid).",
      });
      expect(events[1]?.type).toBe('message');
      expect(events[1]?.text).toMatch(/final answer|forgot the result format/);
    },
  );

  it('fails an error result as agent_failed with a short reason and its final text', () => {
    const { events, outcome } = replay('error', { exitCode: 1, spawnFailed: false });

    expect(events).toContainEqual({ type: 'command', text: 'npm run build' });
    const failure = failed(outcome);
    expect(failure.error).toBeInstanceOf(AgentFailedError);
    expect(failure.error.message).toBe('Claude Code ended with an error (error_max_turns).');
    expect(failure.events).toContainEqual({
      type: 'message',
      text: 'Reached the maximum number of turns.',
    });
  });

  it('fails a non-zero exit as agent_failed, even after a successful result', () => {
    expect(
      failed(replay('success', { exitCode: 3, spawnFailed: false }).outcome).error.message,
    ).toBe('Claude Code exited with code 3.');
    const stream = new ClaudeStream();
    expect(failed(stream.finish({ exitCode: 2, spawnFailed: false })).error.message).toBe(
      'Claude Code exited with code 2 without a result.',
    );
    expect(failed(stream.finish({ exitCode: null, spawnFailed: true })).error.message).toBe(
      'Claude Code could not be started on the agent worker.',
    );
  });

  it('detects the usage limit, says when it resets, and keeps the session', () => {
    const { events, outcome } = replay('usage-limit', { exitCode: 1, spawnFailed: false });

    expect(events[0]).toEqual({
      type: 'notice',
      text: 'The Claude Code usage limit was reached; it resets at 2026-11-22T17:00:00.000Z.',
    });
    const { error } = failed(outcome);
    expect(error).toBeInstanceOf(UsageLimitError);
    expect(error.message).toBe(
      'The Claude Code usage limit was reached; it resets at 2026-11-22T17:00:00.000Z. ' +
        'Resume the run once the limit has reset.',
    );
    expect((error as UsageLimitError).sessionRef).toBe(SESSION);
  });

  it("also detects the usage limit from the CLI's own text, with an older reset format", () => {
    const stream = new ClaudeStream();
    stream.accept(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-2' }));
    stream.accept(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Claude AI usage limit reached|1795366800',
      }),
    );

    const { error } = failed(stream.finish({ exitCode: 1, spawnFailed: false }));
    expect(error).toBeInstanceOf(UsageLimitError);
    expect(error.message).toContain('it resets at 2026-11-22T17:00:00.000Z');
  });

  it('takes the session id only once and only when it fits the protocol', () => {
    const stream = new ClaudeStream();
    stream.accept(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x'.repeat(257) }));
    expect(stream.sessionRef).toBeUndefined();
    stream.accept(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'first' }));
    stream.accept(JSON.stringify({ type: 'assistant', session_id: 'second', message: {} }));
    expect(stream.sessionRef).toBe('first');
  });

  it('cuts a very long text to the protocol limit', () => {
    const stream = new ClaudeStream();
    const [event] = stream.accept(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'x'.repeat(50_000) }] },
      }),
    );
    expect(event?.text.length).toBe(20_000);
  });
});
