'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type RunEventOutput, streamRunEvents } from '../../../../platform/api';
import { followStream, type LiveStatus } from '../../../../platform/realtime/follow-stream';

/** Events read per page of the stored log (the API's largest page). */
export const LOG_PAGE_SIZE = 1000;

/** Where the log stands: loading the stored log, following it live, complete, or failed. */
export type RunLogStatus = 'loading' | LiveStatus | 'complete' | 'error';

export interface RunLog {
  /** The events in seq order, each once. */
  events: readonly RunEventOutput[];
  status: RunLogStatus;
  /** Loads the log again after `error`. */
  retry: () => void;
}

/**
 * A Run's log (Issue #99): the stored log first, page by page (each page shows as it arrives),
 * then, for a Run that was active when the page opened, the live stream from the last seq.
 * On a dropped stream it reconnects after the last seq it has, so the store fills the gap and
 * nothing repeats; events at or below that seq are ignored anyway. Appending pushes onto one
 * array (no copy), so it stays cheap however long the log is.
 */
export function useRunLog(
  runId: string,
  live: boolean,
  { onStepFinished }: { onStepFinished: () => void },
): RunLog {
  // A new wrapper per append (cheap) around one growing array: renders see each append.
  const [log, setLog] = useState<{ events: RunEventOutput[] }>({ events: [] });
  const [status, setStatus] = useState<RunLogStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  // Whether to stream is decided when the log opens: a Run that ends meanwhile ends the stream
  // itself (the server sends `end`), and a finished Run's log is complete once paged.
  const liveAtOpen = useRef(live);
  const stepFinished = useRef(onStepFinished);
  useEffect(() => {
    stepFinished.current = onStepFinished;
  }, [onStepFinished]);

  useEffect(() => {
    const abort = new AbortController();
    const events: RunEventOutput[] = [];
    let last = 0;

    const add = (batch: readonly RunEventOutput[]) => {
      let added = false;
      for (const event of batch) {
        if (event.seq <= last) continue;
        events.push(event);
        last = event.seq;
        added = true;
        if (event.kind === 'step_finished') stepFinished.current();
      }
      if (added) setLog({ events });
    };

    void (async () => {
      try {
        for (;;) {
          const page = await api.listRunEvents(runId, last, LOG_PAGE_SIZE);
          if (abort.signal.aborted) return;
          add(page.events);
          if (page.next === undefined) break;
        }
      } catch {
        if (!abort.signal.aborted) setStatus('error');
        return;
      }
      if (!liveAtOpen.current) {
        setStatus('complete');
        return;
      }
      await followStream({
        signal: abort.signal,
        onStatus: (next) => {
          if (abort.signal.aborted) return;
          setStatus(next);
          if (next === 'ended') stepFinished.current();
        },
        connect: ({ onOpen, signal }) =>
          streamRunEvents(runId, last, { onOpen, signal, onEvent: (event) => add([event]) }),
      });
    })();
    return () => abort.abort();
  }, [runId, attempt]);

  return {
    events: log.events,
    status,
    retry: () => {
      setStatus('loading');
      setLog({ events: [] });
      setAttempt((value) => value + 1);
    },
  };
}
