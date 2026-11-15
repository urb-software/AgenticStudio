'use client';

import { RefreshCwIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Banner } from '@/shared/components/banner';
import { LogViewer } from '@/shared/components/log-viewer';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import type { RunEventOutput, RunOutput, RunStepOutput } from '../../../../platform/api';
import { useRefreshRunSteps, useRunSteps } from '../../api/runs-queries';
import { toLogRows } from './log-rows';
import { type RunLogStatus, useRunLog } from './use-run-log';

/** States in which a Run's log can still grow. */
const ACTIVE: readonly RunOutput['state'][] = [
  'queued',
  'preparing',
  'running',
  'waiting_for_operator',
];

const NO_STEPS: ReadonlyMap<number, RunStepOutput> = new Map();

function emptyText(status: RunLogStatus, run: RunOutput): string {
  if (status === 'loading') return 'Loading the log…';
  if (status === 'complete' || status === 'ended') return 'This run has no log.';
  return run.state === 'queued'
    ? 'The log starts when an agent worker picks the run up.'
    : 'Waiting for the agent’s first output…';
}

function LogNote({ status, events }: { status: RunLogStatus; events: readonly RunEventOutput[] }) {
  if (status !== 'loading' || events.length === 0) return null;
  return <span>Loading more…</span>;
}

/**
 * The Run's log on the Run page (Issue #99): the LogViewer over the stored log, live while the
 * Run is active (new entries appear without a reload; a dropped stream reconnects and fills
 * the gap), with each Run step's structured result at its end.
 */
export function RunLog({ run }: { run: RunOutput }) {
  const refreshSteps = useRefreshRunSteps(run.id);
  const { data: steps } = useRunSteps(run.id);
  const log = useRunLog(run.id, ACTIVE.includes(run.state), {
    onStepFinished: () => void refreshSteps(),
  });
  const rows = useMemo(() => toLogRows(log.events, steps ?? NO_STEPS), [log, steps]);

  return (
    <Card aria-labelledby="run-log-title" className="min-w-0">
      <CardHeader>
        <CardTitle id="run-log-title">Log</CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {log.status === 'error' ? (
          <Banner
            tone="danger"
            title="Couldn’t load the log."
            action={
              <Button size="sm" icon={RefreshCwIcon} onClick={log.retry}>
                Retry
              </Button>
            }
          >
            <span className="font-mono text-small">GET /api/runs/{'{runId}'}/events</span>
          </Banner>
        ) : null}
        <LogViewer
          rows={rows}
          label="Run log"
          streaming={log.status === 'live' || log.status === 'connecting'}
          reconnecting={log.status === 'reconnecting'}
          emptyText={log.status === 'error' ? undefined : emptyText(log.status, run)}
          toolbarEnd={<LogNote status={log.status} events={log.events} />}
        />
      </CardContent>
    </Card>
  );
}
