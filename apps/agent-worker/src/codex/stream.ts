import {
  type RunnerEvent,
  type RunStepResult,
  runStepResultSchema,
  SESSION_REF_MAX_LENGTH,
} from '@agentic-studio/contracts';
import { resultSchemaFor } from '../agent-definition/index.js';
import { AgentFailedError, UsageLimitError } from '../runner.js';
import { withoutNulls } from './result-schema.js';

/**
 * Reads the CLI's `codex exec --json` output of one Run step (one JSON event per line). The
 * recorded streams of the tested version define the shapes; unknown events, items and fields are
 * ignored. A failed turn, or an `error` without a completed turn, fails the step.
 */

/** Longest CLI reason taken into a failure detail. */
const REASON_MAX = 500;

/** Longest text of one runner event (the protocol's limit). */
const EVENT_TEXT_MAX = 20_000;

/** How the CLI's own failure says the plan's usage limit was reached (only failure events). */
const USAGE_LIMIT_TEXT = /usage[ _]limit|hit your (usage )?limit|rate[ _]limit[ _]reached/i;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const cut = (value: string): string =>
  value.length > EVENT_TEXT_MAX ? `${value.slice(0, EVENT_TEXT_MAX - 1)}…` : value;

/** How the process ended. */
export interface ProcessEnd {
  /** The exit code; `null` when it was killed or never started. */
  exitCode: number | null;
  /** It could not be started at all (e.g. the binary is missing). */
  spawnFailed: boolean;
}

/** Where the step's structured result comes from. */
export type ResultSource =
  /** A first step: the `--output-last-message` file's text (`undefined`: none written). */
  | { kind: 'file'; text: string | undefined }
  /** A resumed step: the last agent message of the stream. */
  | { kind: 'last-message' };

/** What the step ended with: its result, or the error to throw after the events to log. */
export type StepOutcome =
  { result: RunStepResult; events: RunnerEvent[] } | { error: Error; events: RunnerEvent[] };

/** The error text of a `turn.failed` or `error` event. */
function failureText(event: Json): string {
  const error = isObject(event.error) ? event.error : undefined;
  return (text(error?.message) ?? text(event.message) ?? '').trim();
}

export class CodexStream {
  private session: string | undefined;
  private completed = false;
  private turnFailed = false;
  private failures: string[] = [];
  private lastMessage: string | undefined;
  private readonly commands = new Set<string>();

  /**
   * @param resumed A resumed step's session, kept when the stream reports none of its own.
   * @param phase The Phase the step belongs to: a review's result carries a Verdict.
   */
  constructor(
    private readonly resumed?: string,
    private readonly phase?: { kind?: 'work' | 'review' },
  ) {}

  /** The session id the CLI reported, else the resumed one. */
  get sessionRef(): string | undefined {
    return this.session ?? this.resumed;
  }

  /** One line of the CLI's output → the Run events it maps to (none for most lines). */
  accept(line: string): RunnerEvent[] {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(event)) return [];
    switch (event.type) {
      case 'thread.started': {
        const id = text(event.thread_id);
        if (this.session === undefined && id && id.length <= SESSION_REF_MAX_LENGTH) {
          this.session = id;
        }
        return [];
      }
      case 'turn.completed':
        this.completed = true;
        return [];
      case 'turn.failed':
      case 'error': {
        const reason = failureText(event);
        this.failures.push(reason);
        if (event.type === 'turn.failed') this.turnFailed = true;
        return [
          {
            type: 'notice',
            text: cut(`Codex reported a failure${reason ? `: ${reason}` : '.'}`),
          },
        ];
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return isObject(event.item) ? this.item(event.item, event.type) : [];
      default:
        return [];
    }
  }

  private item(item: Json, phase: string): RunnerEvent[] {
    const id = text(item.id);
    switch (item.type) {
      case 'agent_message': {
        if (phase !== 'item.completed') return [];
        const value = text(item.text)?.trim();
        if (!value) return [];
        this.lastMessage = value;
        return [{ type: 'message', text: cut(value) }];
      }
      case 'command_execution': {
        const events: RunnerEvent[] = [];
        const command = text(item.command);
        // Each command once: when it starts, or when only its completion is seen.
        const key = id ?? command ?? '';
        if (command !== undefined && !this.commands.has(key) && phase !== 'item.updated') {
          this.commands.add(key);
          events.push({ type: 'command', text: cut(command) });
        }
        if (phase === 'item.completed') {
          const output = text(item.aggregated_output) ?? '';
          if (output !== '') events.push({ type: 'output', text: cut(output) });
        }
        return events;
      }
      case 'file_change': {
        if (phase !== 'item.completed') return [];
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.flatMap((change) =>
          isObject(change) && text(change.path)
            ? [`${text(change.kind) ?? 'change'} ${text(change.path)}`]
            : [],
        );
        return [
          {
            type: 'notice',
            text: cut(
              paths.length > 0 ? `Files changed: ${paths.join(', ')}.` : 'Files were changed.',
            ),
          },
        ];
      }
      case 'error': {
        if (phase !== 'item.completed') return [];
        const message = text(item.message)?.trim();
        return [{ type: 'notice', text: cut(`Codex notice: ${message || 'an error item'}`) }];
      }
      default:
        return [];
    }
  }

  /** How the step ended, once the process has exited. */
  finish(end: ProcessEnd, source: ResultSource): StepOutcome {
    if (end.spawnFailed) {
      return {
        error: new AgentFailedError('Codex could not be started on the agent worker.'),
        events: [],
      };
    }
    // An `error` event the turn recovered from (it still completed, exit 0) is only a notice,
    // e.g. a reconnect; `turn.failed`, or an error with no completed turn, fails the step.
    const failed = this.turnFailed || (this.failures.length > 0 && !this.completed);
    const failure = failed
      ? this.failures.find((reason) => USAGE_LIMIT_TEXT.test(reason))
      : undefined;
    if (failure !== undefined) {
      return {
        error: new UsageLimitError(
          'The Codex usage limit was reached. Resume the run once the limit has reset.',
          this.sessionRef,
        ),
        events: [],
      };
    }
    if (failed) {
      const reason = this.failures.find(Boolean);
      return {
        error: new AgentFailedError(
          `Codex ended with an error${reason ? `: ${reason.slice(0, REASON_MAX)}` : '.'}`,
        ),
        events: [],
      };
    }
    if (end.exitCode !== 0 || !this.completed) {
      const code = end.exitCode === null ? 'was stopped' : `exited with code ${end.exitCode}`;
      return {
        error: new AgentFailedError(
          this.completed ? `Codex ${code}.` : `Codex ${code} without completing its turn.`,
        ),
        events: [],
      };
    }
    const raw = source.kind === 'file' ? source.text?.trim() : this.lastMessage;
    const parsed = parseResult(raw, this.sessionRef, this.phase);
    if (parsed !== undefined) return { result: parsed, events: [] };
    return {
      error: new AgentFailedError(
        this.phase?.kind === 'review'
          ? 'Codex ended the review without a valid structured result with a Verdict. Its final text is in the log.'
          : 'Codex ended without a valid structured result. Its final text is in the log.',
      ),
      events: this.finalText(raw),
    };
  }

  private finalText(value: string | undefined): RunnerEvent[] {
    if (value === undefined || value === '') {
      return [{ type: 'notice', text: 'Codex gave no final text (no structured result).' }];
    }
    return [
      { type: 'notice', text: "Codex's final text follows (its structured result was not valid)." },
      { type: 'message', text: cut(value) },
    ];
  }
}

/**
 * The agent's JSON, validated strictly against the agent result schema, with the session from
 * the stream (never from the agent's output); `undefined` when it is not valid.
 */
function parseResult(
  raw: string | undefined,
  session: string | undefined,
  phase: { kind?: 'work' | 'review' } | undefined,
) {
  if (raw === undefined || raw === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // The strict output schema makes absent fields null.
  const agent = resultSchemaFor(phase).safeParse(withoutNulls(value));
  if (!agent.success) return undefined;
  const result = runStepResultSchema.safeParse({
    ...agent.data,
    ...(session ? { sessionRef: session } : {}),
  });
  return result.success ? result.data : undefined;
}
