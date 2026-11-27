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
  return (
    <Card aria-labelledby="run-phases-title">
      <CardHeader>
        <CardTitle id="run-phases-title">Phases of {workflow.name}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {phases.map((phase) => {
            const view = PHASE_STATE[phase.state];
            return (
              <li
                key={phase.position}
                data-testid="run-phase"
                aria-current={phase.state === 'running' ? 'step' : undefined}
                className="flex flex-col gap-1.5 border-b border-border pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">
                    {phase.position + 1}.{' '}
                    <span className="font-mono text-code">{phase.itemId}</span>
                  </span>
                  <StatusPill status={view.pill}>{view.label}</StatusPill>
                  <span className="text-small text-text-muted">
                    <span className="font-mono text-code">{phase.agent.name}</span> ·{' '}
                    {PROVIDER_LABEL[phase.agent.provider]} · model{' '}
                    <span className="font-mono text-code">{phase.agent.model}</span> ·{' '}
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
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
