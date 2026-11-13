import * as React from 'react';
import { cn } from '@/shared/lib/utils';

type PillStatus = 'queued' | 'running' | 'awaiting' | 'succeeded' | 'failed' | 'cancelled' | 'none';

const LABEL: Record<PillStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting: 'Awaiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  none: 'No runs yet',
};

// The `pill-*` recipes live in globals.css (the design system's own copy); `none` is the
// dashed placeholder, which the recipe file does not define.
const STATUS_CLASS: Record<PillStatus, string> = {
  queued: 'pill-queued',
  running: 'pill-running',
  awaiting: 'pill-awaiting',
  succeeded: 'pill-succeeded',
  failed: 'pill-failed',
  cancelled: 'pill-cancelled',
  none: 'border border-dashed border-border-strong bg-transparent text-text-dim before:hidden',
};

type StatusPillProps = {
  status: PillStatus;
  /** Overrides the label ("Connected", "Merged") without changing the colour logic. */
  children?: React.ReactNode;
  className?: string;
};

/**
 * The state pill (design-system/components/StatusPill): six fixed colours plus the dashed
 * `none` placeholder. The dot plus the word means colour is never the only signal.
 */
function StatusPill({ status, children, className }: StatusPillProps) {
  return (
    <span
      data-slot="status-pill"
      data-status={status}
      className={cn('pill', STATUS_CLASS[status], className)}
    >
      {children ?? LABEL[status]}
    </span>
  );
}

export { StatusPill, type StatusPillProps, type PillStatus };
