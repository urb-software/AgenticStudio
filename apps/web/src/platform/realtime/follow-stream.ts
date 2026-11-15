/** The state of a followed server-sent events stream, as the UI shows it. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'ended';

/** Waits between reconnect attempts: quick at first, then every 10 s, never giving up. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000] as const;

export interface FollowStreamOptions {
  /**
   * Opens one connection; calls `onOpen` once it is open. Resolves `end` when the server
   * finished the stream on purpose, `dropped` otherwise (a rejection counts as dropped). The
   * caller resumes from what it already has (e.g. the last seq), so nothing repeats.
   */
  connect: (handlers: { onOpen: () => void; signal: AbortSignal }) => Promise<'end' | 'dropped'>;
  onStatus: (status: LiveStatus) => void;
  signal: AbortSignal;
  delaysMs?: readonly number[];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * The server-sent events lifecycle (frontend.md §7, Issue #99): connect, report `live` once
 * open, and on a drop report `reconnecting` and connect again with backoff until the server
 * ends the stream (`ended`) or `signal` aborts. Authoritative state comes from the server on
 * every reconnect; this layer holds none.
 */
export async function followStream({
  connect,
  onStatus,
  signal,
  delaysMs = RECONNECT_DELAYS_MS,
}: FollowStreamOptions): Promise<void> {
  let failures = 0;
  onStatus('connecting');
  while (!signal.aborted) {
    let opened = false;
    let result: 'end' | 'dropped';
    try {
      result = await connect({
        signal,
        onOpen: () => {
          opened = true;
          failures = 0;
          onStatus('live');
        },
      });
    } catch {
      result = 'dropped';
    }
    if (signal.aborted) return;
    if (result === 'end') {
      onStatus('ended');
      return;
    }
    if (!opened) failures += 1;
    onStatus('reconnecting');
    await sleep(delaysMs[Math.min(failures, delaysMs.length) - 1] ?? delaysMs[0]!, signal);
  }
}
