/** The state of a followed server-sent events stream, as the UI shows it. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'refused';

/** Waits between reconnect attempts: quick at first, then every 10 s, never giving up. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000] as const;

/** A connection open this long (or one that delivered an event) counts as stable. */
export const STABLE_AFTER_MS = 10_000;

export interface FollowStreamOptions {
  /**
   * Resolves `end` when the server finished the stream on purpose, `refused` when it will not
   * serve it (stop, no retry), `dropped` otherwise. The caller resumes from what it already has,
   * so nothing repeats.
   */
  connect: (handlers: {
    onOpen: () => void;
    /** Call for each delivered event: it marks the connection stable. */
    onEvent: () => void;
    signal: AbortSignal;
  }) => Promise<'end' | 'dropped' | 'refused'>;
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
 * The backoff resets only after a stable connection (one event, or {@link STABLE_AFTER_MS}
 * open). Authoritative state comes from the server on every reconnect; this layer holds none.
 */
export async function followStream({
  connect,
  onStatus,
  signal,
  delaysMs = RECONNECT_DELAYS_MS,
}: FollowStreamOptions): Promise<void> {
  // Connections in a row that dropped before they were stable; the backoff grows with them,
  // so a server or proxy that accepts and drops at once is not hammered every second.
  let failures = 0;
  onStatus('connecting');
  while (!signal.aborted) {
    let stable = false;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    const markStable = () => {
      stable = true;
      failures = 0;
      clearTimeout(stableTimer);
    };
    let result: 'end' | 'dropped' | 'refused';
    try {
      result = await connect({
        signal,
        onOpen: () => {
          onStatus('live');
          stableTimer = setTimeout(markStable, STABLE_AFTER_MS);
        },
        onEvent: () => {
          if (!stable) markStable();
        },
      });
    } catch {
      result = 'dropped';
    } finally {
      clearTimeout(stableTimer);
    }
    if (signal.aborted) return;
    if (result === 'end' || result === 'refused') {
      onStatus(result === 'end' ? 'ended' : 'refused');
      return;
    }
    if (!stable) failures += 1;
    onStatus('reconnecting');
    await sleep(delaysMs[Math.min(Math.max(failures, 1), delaysMs.length) - 1]!, signal);
  }
}
