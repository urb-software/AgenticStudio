import { StatusPill } from '@/shared/components/status-pill';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import type { RunOutput } from '../../../../platform/api';
import { isWorkingCopyPath } from '../../components/finding-path';
import { PROVIDER_LABEL } from '../../components/run-presentation';

type Phase = NonNullable<RunOutput['phases']>[number];
type PhaseState = Phase['state'];
type Finding = Phase['findings'][number];

/** Each Phase state as a pill: the word is always shown, so colour is never the only signal. */
const PHASE_STATE: Record<
  PhaseState,
  { pill: 'queued' | 'running' | 'succeeded' | 'failed'; label: string }
> = {
  pending: { pill: 'queued', label: 'Pending' },
  running: { pill: 'running', label: 'Running' },
  done: { pill: 'succeeded', label: 'Done' },
  failed: { pill: 'failed', label: 'Failed' },
};

const VERDICT_VIEW = {
  approved: { pill: 'succeeded', label: 'Approved' },
  changes_requested: { pill: 'awaiting', label: 'Changes requested' },
} as const;

/**
 * One finding of a review: the reviewer's text as plain text (never Markdown or HTML), and the
 * file and line it names. A file leads to the Changes tab only when it is a relative path inside
 * the Working copy; any other is shown as text and never opened.
 */
function FindingItem({
  finding,
  onShowFile,
}: {
  finding: Finding;
  onShowFile: ((path: string) => void) | undefined;
}) {
  const { file, line } = finding;
  const leads = file !== undefined && onShowFile !== undefined && isWorkingCopyPath(file);
  return (
    <li data-testid="run-finding" className="flex min-w-0 flex-col gap-0.5">
      {file !== undefined ? (
        <span className="text-small text-text-muted">
          {leads ? (
            <button
              type="button"
              onClick={() => onShowFile(file)}
              className="cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-code break-all text-brand underline hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
            >
              {file}
              <span className="sr-only"> (show it on the Changes tab)</span>
            </button>
          ) : (
            <span data-testid="run-finding-file" className="font-mono text-code break-all">
              {file}
            </span>
          )}
          {line !== undefined ? (
            <span className="font-mono text-code">
              <span aria-hidden="true">:</span>
              <span className="sr-only"> line </span>
              {line}
            </span>
          ) : null}
        </span>
      ) : null}
      <span
        data-testid="run-finding-text"
        className="min-w-0 text-small break-words whitespace-pre-wrap text-text"
      >
        {finding.text}
      </span>
    </li>
  );
}

/**
 * The Phases of a Run started with a Workflow, in order: which one works, and each one's agent
 * and what it reported. What a Phase reported, a review's Verdict and its findings are the
 * agents' own text, shown as plain text. `onShowFile` leads a finding's file to the Changes tab.
 */
export function RunPhases({
  run,
  onShowFile,
}: {
  run: RunOutput;
  onShowFile?: (path: string) => void;
}) {
  const { phases, workflow } = run;
  if (!workflow || !phases || phases.length === 0) return null;
  return (
    <Card aria-labelledby="run-phases-title">
      <CardHeader>
        <CardTitle id="run-phases-title" className="break-all">
          Phases of {workflow.name}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {phases.map((phase) => {
            const view = PHASE_STATE[phase.state];
            const verdict = phase.verdict === null ? null : VERDICT_VIEW[phase.verdict];
            return (
              <li
                key={phase.position}
                data-testid="run-phase"
                aria-current={phase.state === 'running' ? 'step' : undefined}
                className="flex flex-col gap-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 font-medium break-all">
                    {phase.position + 1}.{' '}
                    <span className="font-mono text-code break-all">{phase.itemId}</span>
                    {phase.kind === 'review' ? (
                      <span className="font-normal text-text-muted"> (review)</span>
                    ) : null}
                  </span>
                  <StatusPill status={view.pill}>{view.label}</StatusPill>
                  {verdict ? (
                    <StatusPill status={verdict.pill}>
                      <span className="sr-only">Verdict: </span>
                      {verdict.label}
                    </StatusPill>
                  ) : null}
                  <span className="text-small text-text-muted">
                    <span className="font-mono text-code break-all">{phase.agent.name}</span> ·{' '}
                    {PROVIDER_LABEL[phase.agent.provider]} · model{' '}
                    <span className="font-mono text-code break-all">{phase.agent.model}</span> ·{' '}
                    {phase.stepsUsed} {phase.stepsUsed === 1 ? 'run step' : 'run steps'}
                  </span>
                </div>
                {phase.summary ? (
                  <p
                    data-testid="run-phase-summary"
                    className="m-0 text-small break-words whitespace-pre-wrap text-text-muted"
                  >
                    {phase.summary}
                  </p>
                ) : null}
                {phase.findings.length > 0 ? (
                  <section
                    aria-label={`Findings of ${phase.itemId}`}
                    className="flex flex-col gap-1.5"
                  >
                    <h3 className="m-0 text-caption font-medium text-text-dim">
                      {phase.findings.length === 1
                        ? '1 finding'
                        : `${phase.findings.length} findings`}
                    </h3>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0">
                      {phase.findings.map((finding, index) => (
                        <FindingItem key={index} finding={finding} onShowFile={onShowFile} />
                      ))}
                    </ul>
                  </section>
                ) : null}
              </li>
            );
          })}
        </ol>
        {run.reviewNotPassed ? (
          <p
            data-testid="review-not-passed"
            className="m-0 mt-3 text-small font-medium text-run-awaiting"
          >
            Review not passed: the review asked for changes. The run still delivers its pull
            request, and the findings stay open.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
