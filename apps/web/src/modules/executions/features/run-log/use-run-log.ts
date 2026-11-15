'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type RunEventOutput, streamRunEvents } from '../../../../platform/api';
import { followStream, type LiveStatus } from '../../../../platform/realtime/follow-stream';

/** Events read per page of the stored log (the API's largest page). */
export const LOG_PAGE_SIZE = 1000;

/** Live events are shown at most this often: a busy Run re-renders a few times a second. */
const PUBLISH_MS = 100;

/** Where the log stands: loading the stored log, following it live, complete, or failed. */
export type RunLogStatus = 'loading' | Exclude<LiveStatus, 'refused'> | 'complete' | 'error';

export interface RunLog {
  /** The events in seq order, each once (one array that grows; `version` changes with it). */
  events: readonly RunEventOutput[];
  /** Changes whenever `events` grew. */
  version: number;
  status: RunLogStatus;
  /** Loads the log again after `error`. */
  retry: () => void;
}

/**
 * A Run's log (Issue #99): the stored log first, page by page (each page shows as it arrives),
 * then, for a Run that was active when the page opened, the live stream from the last seq.
 * On a dropped stream it reconnects after the last seq it has, so the store fills the gap and
 * nothing repeats; events at or below that seq are ignored anyway. Live events are pushed onto
 * one array and published in batches, so a busy Run does not re-render per event.
 * `onResultsMayChange` fires when a step finishes and when the stream ends.
 */
export function useRunLog(
  runId: string,
  live: boolean,
  { onResultsMayChange }: { onResultsMayChange: () => void },
): RunLog {
  const [log, setLog] = useState<{ events: RunEventOutput[]; version: number }>({
    events: [],
    version: 0,
  });
  const [status, setStatus] = useState<RunLogStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  // Whether to stream is decided when the log opens: a Run that ends meanwhile ends the stream
  // itself (the server sends `end`), and a finished Run's log is complete once paged.
  const liveAtOpen = useRef(live);
  const resultsMayChange = useRef(onResultsMayChange);
  useEffect(() => {
    resultsMayChange.current = onResultsMayChange;
  }, [onResultsMayChange]);

  useEffect(() => {
    const abort = new AbortController();
    const events: RunEventOutput[] = [];
    let last = 0;
    let version = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const publish = () => {
      timer = undefined;
      if (!abort.signal.aborted) setLog({ events, version: ++version });
    };
    const add = (batch: readonly RunEventOutput[], at: 'now' | 'soon') => {
      let added = false;
      for (const event of batch) {
        if (event.seq <= last) continue;
        events.push(event);
        last = event.seq;
        added = true;
        if (event.kind === 'step_finished') resultsMayChange.current();
      }
      if (!added) return;
      if (at === 'now') publish();
      else timer ??= setTimeout(publish, PUBLISH_MS);
    };

    void (async () => {
      try {
        for (;;) {
          const page = await api.listRunEvents(runId, last, LOG_PAGE_SIZE);
          if (abort.signal.aborted) return;
          add(page.events, 'now');
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
          setStatus(next === 'refused' ? 'error' : next);
          if (next === 'ended') resultsMayChange.current();
        },
        connect: ({ onOpen, signal }) =>
          streamRunEvents(runId, last, {
            onOpen,
            signal,
            onEvent: (event) => add([event], 'soon'),
          }),
      });
    })();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [runId, attempt]);

  return {
    events: log.events,
    version: log.version,
    status,
    retry: () => {
      setStatus('loading');
      setLog({ events: [], version: 0 });
      setAttempt((value) => value + 1);
    },
  };
}
