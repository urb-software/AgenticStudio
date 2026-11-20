'use client';

import { RefreshCwIcon } from 'lucide-react';
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Banner } from '@/shared/components/banner';
import { LogViewer, type LogViewerHandle } from '@/shared/components/log-viewer';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card';
import type {
  RunEventOutput,
  RunMessageOutput,
  RunOutput,
  RunStepOutput,
} from '../../../../platform/api';
import { useRefreshRunSteps, useRunSteps } from '../../api/runs-queries';
import { FINAL_STATES } from '../../components/run-states';
import { LogRowBuilder, stepStartRowKey } from './log-rows';
import { type RunLogStatus, useRunLog } from './use-run-log';

const NO_STEPS: ReadonlyMap<number, RunStepOutput> = new Map();
const NO_MESSAGES: readonly RunMessageOutput[] = [];

/** What a screen reader hears when the live log starts and ends (the log is not a live region). */
const LIVE_ANNOUNCEMENT = 'The log is streaming live.';
const ENDED_ANNOUNCEMENT = 'The run has ended; the log is complete.';

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

/** What the Run page can ask of its log (through its `ref`). */
export interface RunLogHandle {
  /** Shows where Run step `index` starts, with focus on the log; false if it is not loaded. */
  showStep(index: number): boolean;
}

/**
 * The Run's log on the Run page: the LogViewer over the stored log, live while the Run is active
 * (new entries appear without a reload; a dropped stream reconnects and fills the gap), with
 * each Run step's structured result at its end.
 */
export function RunLog({ run, ref }: { run: RunOutput; ref?: Ref<RunLogHandle> }) {
  const refreshSteps = useRefreshRunSteps(run.id);
  const { data: steps } = useRunSteps(run.id);
  const log = useRunLog(run.id, !FINAL_STATES.includes(run.state), {
    onResultsMayChange: () => void refreshSteps(),
  });
  // The worker sends a step's end marker before it reports the step's result, and then a
  // new state (e.g. waiting for the operator, whose stream does not end): read the results
  // again whenever the polled state changes.
  useEffect(() => {
    void refreshSteps();
  }, [run.state]); // eslint-disable-line react-hooks/exhaustive-deps -- on state changes only
  // "Streaming live" is said once: the words stay through a reconnect, so the polite status does
  // not change and is not read again; a new load (retry) may say them again.
  const [wentLive, setWentLive] = useState(false);
  if (log.status === 'live' && !wentLive) setWentLive(true);
  if ((log.status === 'loading' || log.status === 'error') && wentLive) setWentLive(false);
  const announcement =
    log.status === 'ended' ? ENDED_ANNOUNCEMENT : wentLive ? LIVE_ANNOUNCEMENT : '';
  const { events, version } = log;
  // Appends each live batch's rows instead of rebuilding them all.
  const [builder] = useState(() => new LogRowBuilder());
  const rows = useMemo(
    () => builder.build(events, steps ?? NO_STEPS, run.messages ?? NO_MESSAGES),
    // `events` grows in place; `version` says it did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [builder, events, version, steps, run.messages],
  );

  const viewer = useRef<LogViewerHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      showStep(index) {
        const key = stepStartRowKey(events, index);
        return key !== undefined && (viewer.current?.scrollToRow(key) ?? false);
      },
    }),
    // `events` grows in place; `version` says it did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, version],
  );

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
          ref={viewer}
          rows={rows}
          label="Run log"
          streaming={log.status === 'live' || log.status === 'connecting'}
          reconnecting={log.status === 'reconnecting'}
          emptyText={log.status === 'error' ? undefined : emptyText(log.status, run)}
          toolbarEnd={<LogNote status={log.status} events={log.events} />}
          announcement={announcement}
        />
      </CardContent>
    </Card>
  );
}
