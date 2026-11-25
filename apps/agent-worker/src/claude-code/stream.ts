import {
  type RunnerEvent,
  type RunStepResult,
  runStepResultSchema,
  SESSION_REF_MAX_LENGTH,
} from '@agentic-studio/contracts';
import { agentResultSchema } from '../agent-definition/index.js';
import { AgentFailedError, UsageLimitError } from '../runner.js';

/**
 * Reads the CLI's `--output-format stream-json --verbose` output of one Run step (one JSON object
 * per line). The recorded streams of the tested CLI version define the shapes; unknown types and
 * fields are ignored, never a failure.
 */

/** Longest text of one runner event (the protocol's limit). */
const EVENT_TEXT_MAX = 20_000;

/**
 * How the CLI's own error result says the subscription's usage limit was reached (only an error
 * result's text is matched, never the agent's messages).
 */
const USAGE_LIMIT_TEXT = /usage limit reached|hit your (usage )?limit/i;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const cut = (value: string): string =>
  value.length > EVENT_TEXT_MAX ? `${value.slice(0, EVENT_TEXT_MAX - 1)}…` : value;

interface ResultEvent {
  subtype: string;
  isError: boolean;
  text: string | undefined;
  structured: unknown;
}

/** How the process ended. */
export interface ProcessEnd {
  /** The exit code; `null` when it was killed or never started. */
  exitCode: number | null;
  /** It could not be started at all (e.g. the binary is missing). */
  spawnFailed: boolean;
}

/** What the step ended with: its result, or the error to throw after the events to log. */
export type StepOutcome =
  { result: RunStepResult; events: RunnerEvent[] } | { error: Error; events: RunnerEvent[] };

export class ClaudeStream {
  private session: string | undefined;
  private result: ResultEvent | undefined;
  private limit: { resetsAt?: number } | undefined;
  private lastText: string | undefined;

  /** The session id the CLI reported, once it has. */
  get sessionRef(): string | undefined {
    return this.session;
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
    const session = text(event.session_id);
    if (
      this.session === undefined &&
      session !== undefined &&
      session.length > 0 &&
      session.length <= SESSION_REF_MAX_LENGTH
    ) {
      this.session = session;
    }
    switch (event.type) {
      case 'assistant':
        return this.assistant(event);
      case 'user':
        return this.toolResults(event);
      case 'system':
        // A permission denial is only a notice: it does not fail the step.
        return event.subtype === 'permission_denied' ? [this.denial(event)] : [];
      case 'rate_limit_event':
        return this.rateLimit(event);
      case 'result':
        this.result = {
          subtype: text(event.subtype) ?? 'unknown',
          isError: event.is_error === true,
          text: text(event.result),
          structured: event.structured_output,
        };
        return [];
      default:
        return [];
    }
  }

  private assistant(event: Json): RunnerEvent[] {
    const message = isObject(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const events: RunnerEvent[] = [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'text') {
        const value = text(block.text)?.trim();
        if (value) {
          this.lastText = value;
          events.push({ type: 'message', text: cut(value) });
        }
      } else if (block.type === 'tool_use' && block.name === 'Bash') {
        const command = isObject(block.input) ? text(block.input.command) : undefined;
        if (command !== undefined) events.push({ type: 'command', text: cut(command) });
      }
    }
    return events;
  }

  private toolResults(event: Json): RunnerEvent[] {
    const message = isObject(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const events: RunnerEvent[] = [];
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const parts = Array.isArray(block.content)
        ? block.content.flatMap((part) => (isObject(part) && text(part.text) ? [part.text] : []))
        : [text(block.content) ?? ''];
      const output = parts.join('\n');
      if (output !== '') events.push({ type: 'output', text: cut(output) });
    }
    return events;
  }

  private denial(event: Json): RunnerEvent {
    const tool = text(event.tool_name) ?? text(event.tool);
    return {
      type: 'notice',
      text: `A tool call was denied by the permission rules${tool ? ` (${tool})` : ''}; the agent goes on.`,
    };
  }

  private rateLimit(event: Json): RunnerEvent[] {
    const info = isObject(event.rate_limit_info) ? event.rate_limit_info : {};
    if (info.status !== 'rejected' || this.limit) return [];
    const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : undefined;
    this.limit = resetsAt === undefined ? {} : { resetsAt };
    return [
      { type: 'notice', text: `The Claude Code usage limit was reached${resetText(resetsAt)}.` },
    ];
  }

  /** The text of the CLI's own error result, when the step ended with one. */
  get errorText(): string | undefined {
    return this.result?.isError ? this.result.text : undefined;
  }

  /** How the step ended, once the process has exited. */
  finish(end: ProcessEnd): StepOutcome {
    if (end.spawnFailed) {
      return {
        error: new AgentFailedError('Claude Code could not be started on the agent worker.'),
        events: [],
      };
    }
    const result = this.result;
    if (result && !result.isError && result.subtype === 'success' && end.exitCode === 0) {
      // The session comes only from the stream, never from the agent's output.
      const agent = agentResultSchema.safeParse(result.structured);
      const parsed = agent.success
        ? runStepResultSchema.safeParse({
            ...agent.data,
            ...(this.session ? { sessionRef: this.session } : {}),
          })
        : agent;
      if (parsed.success) return { result: parsed.data, events: [] };
      return {
        error: new AgentFailedError(
          'Claude Code ended without a valid structured result. Its final text is in the log.',
        ),
        events: this.finalText(result.text, 'its structured result was missing or not valid'),
      };
    }
    const errorText = result?.isError ? result.text : undefined;
    if (this.limit || (errorText !== undefined && USAGE_LIMIT_TEXT.test(errorText))) {
      const resetsAt = this.limit?.resetsAt ?? epochIn(errorText);
      return {
        error: new UsageLimitError(
          `The Claude Code usage limit was reached${resetText(resetsAt)}. ` +
            'Resume the run once the limit has reset.',
          this.session,
        ),
        events: [],
      };
    }
    if (result && (result.isError || result.subtype !== 'success')) {
      return {
        error: new AgentFailedError(`Claude Code ended with an error (${result.subtype}).`),
        events: this.finalText(result.text, 'it ended with an error'),
      };
    }
    const code = end.exitCode === null ? 'was stopped' : `exited with code ${end.exitCode}`;
    return {
      error: new AgentFailedError(
        result ? `Claude Code ${code}.` : `Claude Code ${code} without a result.`,
      ),
      events: [],
    };
  }

  private finalText(value: string | undefined, why: string): RunnerEvent[] {
    if (value === undefined || value.trim() === '') {
      return [{ type: 'notice', text: `Claude Code gave no final text (${why}).` }];
    }
    return [
      { type: 'notice', text: `Claude Code's final text follows (${why}).` },
      { type: 'message', text: cut(value) },
    ];
  }
}

/** "; it resets at <ISO time>" for a reset time in seconds since the epoch, else "". */
function resetText(resetsAt: number | undefined): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= 0) return '';
  const date = new Date(resetsAt * 1000);
  return Number.isNaN(date.getTime()) ? '' : `; it resets at ${date.toISOString()}`;
}

/** The reset time in an older CLI's "Claude AI usage limit reached|<epoch seconds>" text. */
function epochIn(value: string | undefined): number | undefined {
  const match = value ? /\|(\d{9,11})\b/.exec(value) : null;
  return match ? Number(match[1]) : undefined;
}
