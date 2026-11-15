'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * Tones of a log row (design-system/components/LogViewer): `system` for Studio's own words,
 * `command` for `$` lines, `ok`/`error`/`warn`, `tool` for tool output, `dim` for asides,
 * `section` for a lifecycle step's header, `plain` for everything else.
 */
export type LogTone =
  'plain' | 'system' | 'command' | 'tool' | 'ok' | 'error' | 'warn' | 'dim' | 'section';

export interface LogRow {
  /** Stable across appends (e.g. `<seq>:<line>`). */
  key: string;
  text: string;
  tone: LogTone;
}

const TONE_CLASS: Record<LogTone, string> = {
  plain: 'text-text',
  system: 'text-brand',
  command: 'font-semibold text-text',
  tool: 'text-text-muted',
  ok: 'text-run-succeeded',
  error: 'text-run-failed',
  warn: 'text-run-awaiting',
  dim: 'text-text-dim',
  section: 'font-medium text-text-muted',
};

/** Every row is this tall (the design system's 20px code rows), so long logs can be windowed. */
export const LOG_ROW_HEIGHT = 20;

/** Within this many pixels of the end counts as "at the newest row". */
const AT_END_SLACK = 8;

type LogViewerProps = {
  rows: readonly LogRow[];
  /** Names the log for assistive technology (`role="log"`). */
  label: string;
  /** Shown in the toolbar while new rows arrive live. */
  streaming?: boolean;
  /** The live stream dropped; rows stay and resume where they stopped. */
  reconnecting?: boolean;
  /** Shown when there are no rows (e.g. "Waiting for the agent…"). */
  emptyText?: string;
  /** Extra toolbar content on the right (e.g. a loading note). */
  toolbarEnd?: React.ReactNode;
  className?: string;
};

/**
 * Live CLI output (design-system/components/LogViewer): mono, fixed 20px rows with line
 * numbers, windowed so long logs do not freeze the page, long lines scrolling inside the
 * viewer. It follows the newest row while the operator is at the end; scrolling up pauses
 * following and shows "Jump to latest", which resumes it. `reconnecting` shows the amber
 * stream-dropped bar without clearing rows.
 */
function LogViewer({
  rows,
  label,
  streaming = false,
  reconnecting = false,
  emptyText,
  toolbarEnd,
  className,
}: LogViewerProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [following, setFollowing] = React.useState(true);
  const followingRef = React.useRef(true);

  // TanStack Virtual returns functions the React Compiler cannot memoize; it skips this
  // component, which is what windowing needs.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    overscan: 20,
  });

  const scrollToEnd = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  React.useLayoutEffect(() => {
    if (followingRef.current) scrollToEnd();
  }, [rows.length, scrollToEnd]);

  const setFollow = (value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  };

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    // Following scrolls to the end, so only the operator scrolling up turns it off.
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_END_SLACK;
    if (atEnd !== followingRef.current) setFollow(atEnd);
  };

  const jumpToLatest = () => {
    setFollow(true);
    scrollToEnd();
  };

  const items = virtualizer.getVirtualItems();
  const before = items[0]?.start ?? 0;
  const after = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);
  const digits = String(rows.length).length;

  return (
    <div
      data-slot="log-viewer"
      className={cn(
        'relative min-w-0 overflow-hidden rounded-lg border border-border bg-code-bg',
        className,
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-border bg-bg-subtle px-2.5 py-2 text-caption text-text-dim">
        <span>{rows.length === 1 ? '1 line' : `${rows.length} lines`}</span>
        <span className="flex-auto" />
        {toolbarEnd}
        {streaming ? (
          <span className="pill bg-run-running-soft text-run-running">Streaming</span>
        ) : null}
      </div>
      {reconnecting ? (
        <div
          role="status"
          className="flex items-center gap-2.5 border-b border-run-awaiting/30 bg-run-awaiting-soft px-3 py-2 text-small text-run-awaiting"
        >
          <span>
            <b>Reconnecting… </b>Log stream dropped, lines will resume where they stopped.
          </span>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        role="log"
        aria-label={label}
        tabIndex={0}
        onScroll={onScroll}
        className="h-[360px] overflow-auto py-1.5 font-mono text-code focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
      >
        {rows.length === 0 && emptyText ? (
          <p className="m-0 px-3 font-sans text-small text-text-dim">{emptyText}</p>
        ) : null}
        <div style={{ paddingTop: before, paddingBottom: after }} className="w-max min-w-full">
          {items.map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={row.key}
                data-tone={row.tone}
                className="flex h-5 pr-3 whitespace-pre hover:bg-hover"
              >
                <span
                  aria-hidden="true"
                  className="sticky left-0 flex-none bg-code-bg pr-3.5 text-right text-text-dim select-none"
                  style={{ width: `${digits + 3}ch` }}
                >
                  {item.index + 1}
                </span>
                <span className={TONE_CLASS[row.tone]}>{row.text}</span>
              </div>
            );
          })}
        </div>
      </div>
      {!following && rows.length > 0 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3.5 left-1/2 inline-flex h-[30px] -translate-x-1/2 items-center gap-1.5 rounded-full border-0 bg-brand-solid px-3 text-small font-medium text-on-brand shadow-lg hover:bg-brand-solid-hover"
        >
          <ArrowDownIcon aria-hidden="true" className="size-3.5" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

export { LogViewer };
