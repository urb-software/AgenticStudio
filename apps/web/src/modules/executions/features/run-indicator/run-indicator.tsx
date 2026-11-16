'use client';

import Link from 'next/link';
import { cn } from '@/shared/lib/utils';
import type { RunsSummaryOutput } from '../../../../platform/api';
import { useRunsSummary } from '../../api/runs-queries';

type Counts = RunsSummaryOutput;

/** "2 running · 1 waiting for you": the non-zero parts, in that order. */
function textOf({ running, waiting }: Counts): string {
  return [
    running > 0 ? `${running} running` : undefined,
    waiting > 0 ? `${waiting} waiting for you` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The top bar's global run indicator (design-system Layout): shown while any Run is under way
 * or waiting for the operator, linking to the Executions page. A waiting Run makes it amber, the
 * operator's colour. On phones it shrinks to the total, with the full text for screen readers.
 * It reads the Runs summary (two counts; Issue #115), polled only while a Run is active or
 * waiting.
 */
export function RunIndicator() {
  const { data } = useRunsSummary();
  const counts: Counts = data ?? { running: 0, waiting: 0 };
  const total = counts.running + counts.waiting;
  if (total === 0) return null;
  const text = textOf(counts);

  return (
    <Link
      href="/executions"
      data-slot="run-indicator"
      className={cn(
        'inline-flex h-[30px] shrink-0 items-center gap-2 rounded-full border px-3 text-caption font-medium whitespace-nowrap tabular-nums no-underline pointer-coarse:min-h-11',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        counts.waiting > 0
          ? 'border-run-awaiting/35 bg-run-awaiting-soft text-run-awaiting'
          : 'border-run-running/35 bg-run-running-soft text-run-running',
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-current"
      />
      <span className="max-md:sr-only">{text}</span>
      <span aria-hidden="true" className="md:hidden">
        {total}
      </span>
    </Link>
  );
}
