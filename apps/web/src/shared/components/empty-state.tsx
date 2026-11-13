import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

type EmptyStateProps = {
  /** Empty: what to do ("Create your first project"). Error: what failed. */
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** Replaces the icon tile. */
  illustration?: React.ReactNode;
  /** One primary action (empty), "Clear filters" (filtered) or Retry (error). */
  action?: React.ReactNode;
  /** `error`: the list failed to load; announced as an alert. */
  tone?: 'neutral' | 'error';
  className?: string;
};

/** What a list shows when it has nothing or failed to load (design-system/components/EmptyState). */
function EmptyState({
  title,
  description,
  icon: Icon,
  illustration,
  action,
  tone = 'neutral',
  className,
}: EmptyStateProps) {
  const error = tone === 'error';

  return (
    <div
      data-slot="empty-state"
      data-tone={tone}
      role={error ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center gap-3.5 rounded-xl border px-6 py-12 text-center',
        error
          ? 'border-solid border-run-failed/35 bg-run-failed-soft'
          : 'border-dashed border-border-strong bg-bg-subtle',
        className,
      )}
    >
      {illustration ??
        (Icon ? (
          <span
            className={cn(
              'inline-flex size-11 items-center justify-center rounded-xl border border-border bg-surface',
              error ? 'text-run-failed' : 'text-text-muted',
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
          </span>
        ) : null)}
      <h2 className="m-0 text-section-title font-semibold">{title}</h2>
      {description ? (
        <p className="m-0 max-w-[420px] text-body text-text-muted">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

export { EmptyState, type EmptyStateProps };
