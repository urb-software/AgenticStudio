import { FlagIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { Fragment } from 'react';
import { StatusPill } from '@/shared/components/status-pill';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import type { RunOutput } from '../../../../platform/api';
import { PROVIDER_LABEL } from '../../components/run-presentation';
import { FindingItem } from './finding-item';

// Only a Run whose review sent work back has Phases with rounds, so they stay out of the first load.
const PhaseRounds = dynamic(() => import('./phase-rounds'));

type Phase = NonNullable<RunOutput['phases']>[number];
type PhaseState = Phase['state'];

/**
 * Whether a Phase shows its rounds one by one: it ran more than once, or a send-back moved its
 * last result to the rounds and the next round has none yet.
 */
function showsRounds(phase: Phase): boolean {
  return (
    phase.rounds.length > 1 ||
    (phase.rounds.length === 1 && phase.summary === null && phase.verdict === null)
  );
}

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
  const { phases, workflow, sendBacks } = run;
  if (!workflow || !phases || phases.length === 0) return null;
  // The Checkpoints sit between the Phases, in the order of the Workflow.
  const checkpointsBefore = (position: number) => {
    const itemAt = workflow.items.findIndex((item) => item.id === phases[position]?.itemId);
    const previous =
      position > 0
        ? workflow.items.findIndex((item) => item.id === phases[position - 1]?.itemId)
        : -1;
    return workflow.items.slice(previous + 1, itemAt).filter((item) => item.kind === 'checkpoint');
  };
  return (
    <Card aria-labelledby="run-phases-title">
      <CardHeader>
        <CardTitle id="run-phases-title" className="break-all">
          Phases of {workflow.name}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sendBacks ? (
          <p data-testid="run-send-backs" className="m-0 mb-3 text-small text-text-muted">
            Send-backs used: {sendBacks.used} of {sendBacks.limit}
          </p>
        ) : null}
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {phases.map((phase) => {
            const view = PHASE_STATE[phase.state];
            const verdict = phase.verdict === null ? null : VERDICT_VIEW[phase.verdict];
            return (
              <Fragment key={phase.position}>
                {checkpointsBefore(phase.position).map((checkpoint) => {
                  const waiting =
                    run.state === 'waiting_for_operator' &&
                    run.waiting?.checkpoint?.id === checkpoint.id;
                  return (
                    <li
                      key={checkpoint.id}
                      data-testid="run-checkpoint-item"
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-3"
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
                        <FlagIcon aria-hidden="true" className="size-3.5 shrink-0" />
                        <span>Checkpoint</span>
                        <span className="font-mono text-code break-all">{checkpoint.id}</span>
                      </span>
                      {waiting ? (
                        <StatusPill status="awaiting">Waiting for you</StatusPill>
                      ) : phase.state === 'pending' ? null : (
                        <span className="text-small text-text-muted">Passed</span>
                      )}
                    </li>
                  );
                })}
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
                  {showsRounds(phase) ? (
                    <PhaseRounds phase={phase} onShowFile={onShowFile} />
                  ) : null}
                  {!showsRounds(phase) && phase.summary ? (
                    <p
                      data-testid="run-phase-summary"
                      className="m-0 text-small break-words whitespace-pre-wrap text-text-muted"
                    >
                      {phase.summary}
                    </p>
                  ) : null}
                  {!showsRounds(phase) && phase.findings.length > 0 ? (
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
              </Fragment>
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
