import type { LogRow, LogTone } from '@/shared/components/log-viewer';
import type { RunEventOutput, RunStepOutput } from '../../../../platform/api';

/** What Studio puts in place of a redacted secret (security.md §3). */
const REDACTED = '••••••[redacted]';

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

/** A redacted line is shown as a warning, so the operator sees something was hidden. */
const toneOf = (line: string, tone: LogTone): LogTone =>
  line.includes(REDACTED) && tone !== 'section' ? 'warn' : tone;

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
 * The rows of a Run's log for the LogViewer: each event's text line by line (commands as `$`
 * lines, notices as warnings, step markers as section rows), a note under a cut event, and the
 * step's structured result right after its `step_finished` marker once it is known.
 */
export function toLogRows(
  events: readonly RunEventOutput[],
  steps: ReadonlyMap<number, RunStepOutput>,
): LogRow[] {
  const rows: LogRow[] = [];
  for (const event of events) {
    const tone = KIND_TONE[event.kind];
    lines(event.text).forEach((line, i) => {
      const text = event.kind === 'command' ? `${i === 0 ? '$' : ' '} ${line}` : line;
      rows.push({ key: `${event.seq}:${i}`, text, tone: toneOf(line, tone) });
    });
    if (event.truncated) {
      rows.push({
        key: `${event.seq}:cut`,
        text: '… (cut: longer than an entry may be)',
        tone: 'dim',
      });
    }
    const step = event.kind === 'step_finished' ? steps.get(event.stepIndex) : undefined;
    if (step) rows.push(...resultRows(step));
  }
  return rows;
}
