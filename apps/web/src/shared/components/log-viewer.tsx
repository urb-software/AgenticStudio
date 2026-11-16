'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * Tones of a log row (design-system/components/LogViewer): `system` for Studio's own words,
 * `command` for `$` lines, `edit` for file writes, `ok`/`error`/`warn`, `tool` for tool
 * output, `dim` for asides, `plain` (the spec's default) for everything else. `section` marks
 * a lifecycle step's header: it starts a collapsible section of the rows below it.
 */
export type LogTone =
  'plain' | 'system' | 'command' | 'edit' | 'tool' | 'ok' | 'error' | 'warn' | 'dim' | 'section';

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
  edit: 'text-run-running',
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

/** A row in view: its line number, and for a section header the rows it holds. */
type VisibleRow = { row: LogRow; number: number; size: number };

/** The rows in view for `rows` and `collapsed`, with what extending them needs. */
interface Visible {
  rows: readonly LogRow[];
  collapsed: ReadonlySet<string>;
  shown: readonly VisibleRow[];
  /** Index in `shown` of the last section header, or -1 before the first one. */
  header: number;
  /** Whether the last section is collapsed (its rows are left out). */
  hiding: boolean;
}

/**
 * The rows in view: every row keeps its line number; rows of a collapsed section are left out.
 * When `rows` only grew since `previous` (a live batch appended to the same rows) and nothing
 * was collapsed or expanded, only the new rows are walked (Issue #115); otherwise all are.
 */
function visibleRows(
  previous: Visible | undefined,
  rows: readonly LogRow[],
  collapsed: ReadonlySet<string>,
): Visible {
  if (previous && previous.rows === rows && previous.collapsed === collapsed) return previous;
  const from = previous?.rows.length ?? 0;
  const grew =
    previous !== undefined &&
    previous.collapsed === collapsed &&
    from <= rows.length &&
    (from === 0 || (rows[0] === previous.rows[0] && rows[from - 1] === previous.rows[from - 1]));
  const start = grew ? from : 0;
  const added: VisibleRow[] = [];
  let header = grew ? previous.header : -1;
  let hiding = grew ? previous.hiding : false;
  // Rows added to the section that was already open when the batch arrived.
  let grown = 0;
  for (let index = start; index < rows.length; index++) {
    const row = rows[index]!;
    const number = index + 1;
    if (row.tone === 'section') {
      hiding = collapsed.has(row.key);
      added.push({ row, number, size: 0 });
      header = (grew ? previous.shown.length : 0) + added.length - 1;
      continue;
    }
    const at = header - (grew ? previous.shown.length : 0);
    if (at >= 0) added[at]!.size += 1;
    else if (header >= 0) grown += 1;
    if (!hiding) added.push({ row, number, size: 0 });
  }
  const shown = grew ? previous.shown.concat(added) : added;
  if (grew && grown > 0) {
    // The earlier section's header gets a new size; the previous rows stay untouched.
    const last = previous.header;
    shown[last] = { ...shown[last]!, size: shown[last]!.size + grown };
  }
  return { rows, collapsed, shown, header, hiding };
}

/** What a parent can ask of the viewer (through its `ref`). */
export interface LogViewerHandle {
  /**
   * Shows the row with this key at the top of the log and moves keyboard focus to the log,
   * which pauses following. False when no row in view has the key.
   */
  scrollToRow(key: string): boolean;
}

type LogViewerProps = {
  ref?: React.Ref<LogViewerHandle>;
  /**
   * The rows, in order. To append, pass a new array that starts with the same row objects:
   * only the new rows are then laid out (Issue #115); anything else is laid out afresh.
   */
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
  /**
   * Said politely to assistive technology when it changes (e.g. "The log is streaming live.",
   * "The log is complete."), since the log itself is not a live region.
   */
  announcement?: string;
  className?: string;
};

/**
 * Live CLI output (design-system/components/LogViewer): mono, fixed 20px rows with line
 * numbers, windowed so long logs do not freeze the page, long lines scrolling inside the
 * viewer. Each `section` row is a button that collapses the rows up to the next section. It
 * follows the newest row while the operator is at the end; scrolling up pauses following and
 * shows "Jump to latest", which resumes it. `reconnecting` shows the amber stream-dropped bar
 * without clearing rows. The log is not a live region (`aria-live="off"`): windowing mounts
 * old rows while scrolling, which a screen reader would announce as new.
 */
function LogViewer({
  ref,
  rows,
  label,
  streaming = false,
  reconnecting = false,
  emptyText,
  toolbarEnd,
  announcement = '',
  className,
}: LogViewerProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [following, setFollowing] = React.useState(true);
  const followingRef = React.useRef(true);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());

  // Derived from the previous render's rows in view, so a live batch walks only its own rows.
  const [layout, setLayout] = React.useState<Visible>(() =>
    visibleRows(undefined, rows, collapsed),
  );
  const current = visibleRows(layout, rows, collapsed);
  if (current !== layout) setLayout(current);
  const visible = current.shown;

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // TanStack Virtual returns functions the React Compiler cannot memoize; it skips this
  // component, which is what windowing needs.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
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
  }, [visible.length, scrollToEnd]);

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

  React.useImperativeHandle(
    ref,
    () => ({
      scrollToRow(key) {
        const element = scrollRef.current;
        const index = visible.findIndex((item) => item.row.key === key);
        if (!element || index === -1) return false;
        // Fixed row heights: the row's offset is its index in view (Issue #115).
        setFollow(false);
        element.scrollTop = index * LOG_ROW_HEIGHT;
        element.focus();
        return true;
      },
    }),
    [visible],
  );

  const jumpToLatest = () => {
    setFollow(true);
    scrollToEnd();
    // The button goes away: keep keyboard focus on the log, not the page body.
    scrollRef.current?.focus();
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
      <p role="status" className="sr-only m-0">
        {announcement}
      </p>
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
        aria-live="off"
        aria-label={label}
        tabIndex={0}
        onScroll={onScroll}
        className="max-h-[360px] min-h-24 overflow-auto py-1.5 font-mono text-code focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
      >
        {rows.length === 0 && emptyText ? (
          <p className="m-0 px-3 font-sans text-small text-text-dim">{emptyText}</p>
        ) : null}
        <div style={{ paddingTop: before, paddingBottom: after }} className="w-max min-w-full">
          {items.map((item) => {
            const { row, number, size } = visible[item.index]!;
            const text = (
              <span data-slot="log-text" className={TONE_CLASS[row.tone]}>
                {row.text}
              </span>
            );
            const isOpen = !collapsed.has(row.key);
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
                  {number}
                </span>
                {row.tone === 'section' ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggle(row.key)}
                    className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 font-mono text-code hover:text-text"
                  >
                    {isOpen ? (
                      <ChevronDownIcon aria-hidden="true" className="size-3.5 text-text-dim" />
                    ) : (
                      <ChevronRightIcon aria-hidden="true" className="size-3.5 text-text-dim" />
                    )}
                    {text}
                    {size ? <span className="text-text-dim">· {size}</span> : null}
                  </button>
                ) : (
                  text
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!following && rows.length > 0 ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3.5 left-1/2 inline-flex h-[30px] -translate-x-1/2 items-center gap-1.5 rounded-full border-0 bg-brand-solid px-3 text-small font-medium text-on-brand shadow-float hover:bg-brand-solid-hover"
        >
          <ArrowDownIcon aria-hidden="true" className="size-3.5" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

export { LogViewer };
