import { StatusPill } from '@/shared/components/status-pill';
import type { RunOutput } from '../../../../platform/api';
import { FindingItem } from './finding-item';

type Phase = NonNullable<RunOutput['phases']>[number];

const VERDICT_VIEW = {
  approved: { pill: 'succeeded', label: 'Approved' },
  changes_requested: { pill: 'awaiting', label: 'Changes requested' },
} as const;

/**
 * The rounds of a Phase that ran more than once because a review sent the work back, oldest
 * first: a review's Verdict and findings, and what a work Phase reported after them. Everything an
 * agent wrote is plain text. Loaded only when a Run has such a Phase.
 */
export default function PhaseRounds({
  phase,
  onShowFile,
}: {
  phase: Phase;
  onShowFile: ((path: string) => void) | undefined;
}) {
  const waiting = phase.summary === null && phase.verdict === null;
  const next = (phase.rounds.at(-1)?.round ?? 0) + 1;
  return (
    <section aria-label={`Rounds of ${phase.itemId}`} className="flex flex-col gap-2">
      <h3 className="m-0 text-caption font-medium text-text-dim">
        {phase.kind === 'review' ? 'Reviews' : 'Work'} in {phase.rounds.length}{' '}
        {phase.rounds.length === 1 ? 'round' : 'rounds'}
      </h3>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {phase.rounds.map((round) => {
          const verdict = round.verdict === null ? null : VERDICT_VIEW[round.verdict];
          return (
            <li
              key={round.round}
              data-testid="run-phase-round"
              className="flex min-w-0 flex-col gap-1 border-l-2 border-border pl-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">Round {round.round}</span>
                {verdict ? (
                  <StatusPill status={verdict.pill}>
                    <span className="sr-only">Verdict: </span>
                    {verdict.label}
                  </StatusPill>
                ) : null}
              </div>
              {round.summary ? (
                <p
                  data-testid="run-round-summary"
                  className="m-0 text-small break-words whitespace-pre-wrap text-text-muted"
                >
                  {round.summary}
                </p>
              ) : null}
              {round.findings.length > 0 ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {round.findings.map((finding, index) => (
                    <FindingItem key={index} finding={finding} onShowFile={onShowFile} />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
        {waiting ? (
          <li
            data-testid="run-phase-round"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-l-2 border-border pl-3"
          >
            <span className="font-medium">Round {next}</span>
            <span className="text-small text-text-muted">
              {phase.state === 'running'
                ? 'Working now'
                : phase.state === 'failed'
                  ? 'Did not finish'
                  : 'Waiting for its turn'}
            </span>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
