import * as React from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * Agent Studio Card (design-system/components/Card): surface fill, hairline border, radius-lg,
 * no shadow. The header row holds the title and at most two small actions; `CardContent flush`
 * lets lists and tables run edge to edge. Cards don't nest.
 */
function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="card"
      className={cn(
        'flex flex-col rounded-lg border border-border bg-surface text-body text-text',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'flex items-center justify-between gap-3 border-b border-border px-4 py-3.5',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="card-title"
      className={cn('m-0 text-body font-semibold', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('m-0 text-small text-text-muted', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('flex shrink-0 items-center gap-2', className)}
      {...props}
    />
  );
}

function CardContent({
  className,
  flush = false,
  ...props
}: React.ComponentProps<'div'> & {
  /** Children run edge to edge (lists, tables). */
  flush?: boolean;
}) {
  return <div data-slot="card-content" className={cn(!flush && 'p-4', className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 border-t border-border px-4 py-3', className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
