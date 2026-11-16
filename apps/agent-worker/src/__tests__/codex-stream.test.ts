import { runnerEventSchema, type RunnerEvent } from '@agentic-studio/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexStream, type ResultSource } from '../codex/stream.js';
import { AgentFailedError, UsageLimitError } from '../runner.js';

// Issue #106: the Codex `exec --json` stream of one Run step → Run events and the step's end,
// on the recorded streams the stub executable replays.

const THREAD = '0199a8f2-6c1e-7d43-9b2a-5e8f1c3d7a90';
const recording = (name: string) =>
  readFileSync(new URL(`./fixtures/codex-recordings/${name}.jsonl`, import.meta.url), 'utf8');

/** The last agent message of a recording: what `--output-last-message` holds. */
function lastMessage(name: string): string | undefined {
  return recording(name)
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { item?: { type?: string; text?: string } };
        return event.item?.type === 'agent_message' && event.item.text ? [event.item.text] : [];
      } catch {
        return [];
      }
    })
    .at(-1);
}

function replay(name: string) {
  const stream = new CodexStream();
  const events: RunnerEvent[] = [];
  for (const line of recording(name).split('\n')) events.push(...stream.accept(line));
  return { stream, events };
}

const file = (name: string): ResultSource => ({ kind: 'file', text: lastMessage(name) });
const ok = { exitCode: 0, spawnFailed: false };

describe('the Codex stream', () => {
  it('maps commands, their output, file changes, messages and error items; skips reasoning', () => {
    const { stream, events } = replay('success');

    expect(stream.sessionRef).toBe(THREAD);
    expect(events).toEqual([
      { type: 'command', text: "/bin/bash -lc 'npm test -- --run'" },
      { type: 'output', text: 'Tests  3 passed (3)\n' },
      { type: 'notice', text: 'Files changed: add src/health.ts.' },
      {
        type: 'notice',
        text: 'Codex notice: Codex is ignoring 1 unrecognized configuration setting.',
      },
      { type: 'message', text: expect.stringContaining('"outcome":"done"') },
    ]);
    for (const event of events) expect(runnerEventSchema.safeParse(event).success).toBe(true);
  });

  it('ends a first step with the result file, validated, and the session from the stream', () => {
    const { stream } = replay('success');

    expect(stream.finish(ok, file('success'))).toEqual({
      result: {
        outcome: 'done',
        summary: 'Added a health check endpoint.',
        pullRequest: { title: 'Add a health check', body: 'Assumption: GET /health.' },
        checks: [{ name: 'npm test', result: 'passed' }],
        sessionRef: THREAD,
      },
      events: [],
    });
  });

  it("ends a question with the agent's question and the session to resume", () => {
    const { stream } = replay('question');

    const outcome = stream.finish(ok, file('question'));

    expect(outcome).toMatchObject({
      result: {
        outcome: 'needs_input',
        question: { text: 'Which store should I use?', recommendation: 'PostgreSQL' },
        sessionRef: THREAD,
      },
    });
  });

  it('ends a resumed step with its last agent message, validated', () => {
    const { stream } = replay('resume');

    expect(stream.finish(ok, { kind: 'last-message' })).toEqual({
      result: { outcome: 'done', summary: 'Added the store on PostgreSQL.', sessionRef: THREAD },
      events: [],
    });
  });

  it('fails without a valid structured result and logs the final text', () => {
    const { stream } = replay('invalid-result');

    const outcome = stream.finish(ok, { kind: 'last-message' });

    expect('error' in outcome && outcome.error).toBeInstanceOf(AgentFailedError);
    expect(outcome.events).toEqual([
      { type: 'notice', text: "Codex's final text follows (its structured result was not valid)." },
      { type: 'message', text: 'All done, the health check is in place.' },
    ]);
  });

  it('fails a first step whose result file is missing', () => {
    const { stream } = replay('success');

    const outcome = stream.finish(ok, { kind: 'file', text: undefined });

    expect('error' in outcome && outcome.error.message).toBe(
      'Codex ended without a valid structured result. Its final text is in the log.',
    );
  });

  it('refuses a result with fields outside the agent result, or a session the agent wrote', () => {
    const { stream } = replay('success');
    const text = JSON.stringify({ outcome: 'done', summary: 's', sessionRef: 'not-from-agent' });

    expect('error' in stream.finish(ok, { kind: 'file', text })).toBe(true);
  });

  it('fails a failed turn with its reason', () => {
    const { stream, events } = replay('turn-failed');

    const outcome = stream.finish({ exitCode: 1, spawnFailed: false }, file('turn-failed'));

    expect('error' in outcome && outcome.error).toBeInstanceOf(AgentFailedError);
    expect('error' in outcome && outcome.error.message).toBe(
      'Codex ended with an error: stream disconnected before completion',
    );
    expect(events.at(-1)).toEqual({
      type: 'notice',
      text: 'Codex reported a failure: stream disconnected before completion',
    });
  });

  it("detects the usage limit from the CLI's own failure, keeping the session", () => {
    const { stream } = replay('usage-limit');

    const outcome = stream.finish({ exitCode: 1, spawnFailed: false }, file('usage-limit'));

    expect('error' in outcome && outcome.error).toBeInstanceOf(UsageLimitError);
    expect('error' in outcome && (outcome.error as UsageLimitError).sessionRef).toBe(THREAD);
  });

  it("never takes a usage limit from the agent's own messages", () => {
    const stream = new CodexStream();
    stream.accept(JSON.stringify({ type: 'thread.started', thread_id: THREAD }));
    stream.accept(
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: "You've hit your usage limit." },
      }),
    );
    stream.accept(JSON.stringify({ type: 'turn.completed' }));

    const outcome = stream.finish(ok, { kind: 'last-message' });
    expect('error' in outcome && outcome.error).toBeInstanceOf(AgentFailedError);
  });

  it('keeps an error event the turn recovered from as a notice', () => {
    const { stream, events } = replay('recovered-error');

    expect(events[0]).toEqual({
      type: 'notice',
      text: 'Codex reported a failure: Reconnecting... 1/5',
    });
    expect(stream.finish(ok, file('recovered-error'))).toMatchObject({
      result: { outcome: 'done', summary: 'Done after a reconnect.' },
    });
  });

  it('ignores unknown events, item types and lines that are not JSON', () => {
    const { stream, events } = replay('unknown-events');

    expect(events).toEqual([
      { type: 'message', text: '{"outcome":"done","summary":"Nothing to change."}' },
    ]);
    expect(stream.finish(ok, file('unknown-events'))).toMatchObject({
      result: { outcome: 'done' },
    });
  });

  it('logs a command once, also when only its completion is seen', () => {
    const stream = new CodexStream();
    const events = [
      ...stream.accept(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'i', type: 'command_execution', command: 'ls', aggregated_output: 'a\n' },
        }),
      ),
    ];
    expect(events).toEqual([
      { type: 'command', text: 'ls' },
      { type: 'output', text: 'a\n' },
    ]);
  });

  it('fails a non-zero exit, a turn that never completed and a CLI that did not start', () => {
    const done = replay('success').stream;
    expect(done.finish({ exitCode: 3, spawnFailed: false }, file('success'))).toMatchObject({
      error: { message: 'Codex exited with code 3.' },
    });
    const partial = new CodexStream();
    partial.accept(JSON.stringify({ type: 'thread.started', thread_id: THREAD }));
    expect(partial.finish(ok, { kind: 'last-message' })).toMatchObject({
      error: { message: 'Codex exited with code 0 without completing its turn.' },
    });
    expect(
      new CodexStream().finish({ exitCode: null, spawnFailed: true }, { kind: 'last-message' }),
    ).toMatchObject({ error: { message: 'Codex could not be started on the agent worker.' } });
  });
});
