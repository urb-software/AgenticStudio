import { FlagIcon } from 'lucide-react';
import { Fragment } from 'react';
import { StatusPill } from '@/shared/components/status-pill';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import type { RunOutput } from '../../../../platform/api';
import { PROVIDER_LABEL } from '../../components/run-presentation';

type PhaseState = NonNullable<RunOutput['phases']>[number]['state'];

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

/**
 * The Phases of a Run started with a Workflow, in order: which one works, and each one's agent
 * and what it reported. What a Phase reported is the agent's own text, shown as plain text.
 */
export function RunPhases({ run }: { run: RunOutput }) {
  const { phases, workflow } = run;
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
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {phases.map((phase) => {
            const view = PHASE_STATE[phase.state];
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
                    </span>
                    <StatusPill status={view.pill}>{view.label}</StatusPill>
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
                </li>
              </Fragment>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
