import type { LogRow, LogTone } from '@/shared/components/log-viewer';
import type { RunEventOutput, RunMessageOutput, RunStepOutput } from '../../../../platform/api';

const KIND_TONE: Record<RunEventOutput['kind'], LogTone> = {
  message: 'plain',
  command: 'command',
  output: 'tool',
  notice: 'warn',
  step_started: 'section',
  step_finished: 'section',
};

const CHECK_ROW: Record<RunStepOutput['checks'][number]['result'], [string, LogTone]> = {
  passed: ['✓', 'ok'],
  failed: ['✗', 'error'],
  not_run: ['○', 'dim'],
};

const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');

/** A redacted entry is shown as a warning, so the operator sees something was hidden. */
const toneOf = (event: RunEventOutput, tone: LogTone): LogTone =>
  event.redacted && tone !== 'section' ? 'warn' : tone;

/** The structured result shown at the end of its Run step: outcome, summary, checks. */
function resultRows(step: RunStepOutput): LogRow[] {
  const key = `step-${step.index}`;
  const rows: LogRow[] = [
    {
      key: `${key}:outcome`,
      text: step.outcome === 'done' ? 'Result: done' : 'Result: needs input',
      tone: 'section',
    },
  ];
  lines(step.summary).forEach((line, i) => {
    if (line || i > 0) rows.push({ key: `${key}:summary:${i}`, text: line, tone: 'plain' });
  });
  step.checks.forEach((check, c) => {
    const [mark, tone] = CHECK_ROW[check.result];
    const label = check.result === 'not_run' ? `${check.name} (not run)` : check.name;
    rows.push({ key: `${key}:check:${c}`, text: `${mark} ${label}`, tone });
    if (check.detail) {
      lines(check.detail).forEach((line, i) =>
        rows.push({ key: `${key}:check:${c}:${i}`, text: `    ${line}`, tone: 'dim' }),
      );
    }
  });
  return rows;
}

/**
 * Both are operator `answer` messages: an answer comes right after its question, a resume
 * follows the Task or an answer (a Run waiting for an answer is never stopped at the limit) and
 * runs the step after the last asked question again.
 */
function questionsAndAnswers(messages: readonly RunMessageOutput[]) {
  const turns: { question: string; answer?: string }[] = [];
  const resumes = new Map<number, string[]>();
  messages.forEach((message, i) => {
    if (message.kind === 'question') turns.push({ question: message.text });
    else if (message.kind !== 'answer') return;
    else if (messages[i - 1]?.kind === 'question') turns.at(-1)!.answer = message.text;
    else {
      const step = turns.length + 1;
      resumes.set(step, [...(resumes.get(step) ?? []), message.text]);
    }
  });
  return { turns, resumes };
}

/** The question a `needs_input` step ended with and the answer that resumed the Run. */
function turnRows(index: number, turn: { question: string; answer?: string }): LogRow[] {
  const key = `step-${index}:turn`;
  const rows: LogRow[] = [];
  lines(turn.question).forEach((line, i) =>
    rows.push({ key: `${key}:q:${i}`, text: i === 0 ? `Question: ${line}` : line, tone: 'warn' }),
  );
  if (turn.answer !== undefined) {
    lines(turn.answer).forEach((line, i) =>
      rows.push({ key: `${key}:a:${i}`, text: i === 0 ? `Answer: ${line}` : line, tone: 'ok' }),
    );
  }
  return rows;
}

type Turn = ReturnType<typeof questionsAndAnswers>['turns'][number];

/** The key of an event's `line`-th row: stable across appends. */
const rowKey = (event: RunEventOutput, line: number | 'cut') => `${event.seq}:${line}`;

/**
 * The key of the row that starts Run step `index` (its `step_started` marker), if it is loaded.
 * A step run again after a usage-limit resume has a marker per attempt: the last one is the
 * attempt that produced the step's result.
 */
export function stepStartRowKey(
  events: readonly RunEventOutput[],
  index: number,
): string | undefined {
  const event = events.findLast((e) => e.kind === 'step_started' && e.stepIndex === index);
  return event ? rowKey(event, 0) : undefined;
}

/** What the rows of a log need besides its events, and what they have seen so far. */
interface RowContext {
  steps: ReadonlyMap<number, RunStepOutput>;
  turnOfStep: ReadonlyMap<number, Turn>;
  /** Resume texts by the Run step they ran again, in order. */
  resumes: ReadonlyMap<number, readonly string[]>;
  /** `step_started` markers seen so far, per step: a repeated one follows a resume. */
  starts: Map<number, number>;
}

/** Which turn follows which `needs_input` step: the n-th such step asked the n-th question. */
function rowContext(
  steps: ReadonlyMap<number, RunStepOutput>,
  messages: readonly RunMessageOutput[],
): RowContext {
  const { turns, resumes } = questionsAndAnswers(messages);
  const turnOfStep = new Map<number, Turn>();
  [...steps.values()]
    .filter((step) => step.outcome === 'needs_input')
    .sort((a, b) => a.index - b.index)
    .forEach((step, n) => {
      const turn = turns[n];
      if (turn) turnOfStep.set(step.index, turn);
    });
  return { steps, turnOfStep, resumes, starts: new Map() };
}

/** One event's rows, followed by its step's result and turn when it ends a known step. */
function eventRows(event: RunEventOutput, context: RowContext, rows: LogRow[]): void {
  const { steps, turnOfStep } = context;
  if (event.kind === 'step_started') {
    // The n-th repeat of a step's marker is the attempt the n-th resume of that step started.
    const seen = context.starts.get(event.stepIndex) ?? 0;
    context.starts.set(event.stepIndex, seen + 1);
    const resume = seen > 0 ? context.resumes.get(event.stepIndex)?.[seen - 1] : undefined;
    if (resume !== undefined) {
      lines(resume).forEach((line, i) =>
        rows.push({
          key: `${event.seq}:resume:${i}`,
          text: i === 0 ? `Resumed: ${line}` : line,
          tone: 'ok',
        }),
      );
    }
  }
  const tone = KIND_TONE[event.kind];
  lines(event.text).forEach((line, i) => {
    const text = event.kind === 'command' ? `${i === 0 ? '$' : ' '} ${line}` : line;
    rows.push({ key: rowKey(event, i), text, tone: toneOf(event, tone) });
  });
  if (event.truncated) {
    rows.push({
      key: rowKey(event, 'cut'),
      text: '… (cut: longer than an entry may be)',
      tone: 'dim',
    });
  }
  const step = event.kind === 'step_finished' ? steps.get(event.stepIndex) : undefined;
  if (step) rows.push(...resultRows(step));
  const turn = step ? turnOfStep.get(step.index) : undefined;
  if (step && turn) rows.push(...turnRows(step.index, turn));
}

/**
 * Built incrementally: the log's events array grows in place, so a live batch appends only the
 * new events' rows and earlier rows stay the same objects. New step results or messages, or a
 * new events array, lay the rows out again.
 */
export class LogRowBuilder {
  private built:
    | {
        events: readonly RunEventOutput[];
        steps: ReadonlyMap<number, RunStepOutput>;
        messages: readonly RunMessageOutput[];
        context: RowContext;
        /** How many events the rows cover. */
        count: number;
        rows: readonly LogRow[];
      }
    | undefined;

  build(
    events: readonly RunEventOutput[],
    steps: ReadonlyMap<number, RunStepOutput>,
    messages: readonly RunMessageOutput[],
  ): readonly LogRow[] {
    const built = this.built;
    const grows =
      built !== undefined &&
      built.events === events &&
      built.steps === steps &&
      built.messages === messages &&
      built.count <= events.length;
    const base = grows
      ? built
      : {
          events,
          steps,
          messages,
          context: rowContext(steps, messages),
          count: 0,
          rows: [] as readonly LogRow[],
        };
    if (grows && base.count === events.length) return base.rows;
    const added: LogRow[] = [];
    for (let i = base.count; i < events.length; i++) {
      eventRows(events[i]!, base.context, added);
    }
    this.built = { ...base, count: events.length, rows: base.rows.concat(added) };
    return this.built.rows;
  }
}
