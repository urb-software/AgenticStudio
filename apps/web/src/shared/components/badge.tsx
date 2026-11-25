import * as React from 'react';
import { cn } from '@/shared/lib/utils';

type BadgeProps = React.ComponentProps<'span'>;

/**
 * A small label for identity, not state (design-system/components/Badge): the `neutral` variant,
 * for what a thing is ("Definitions Repository"). Run state is the StatusPill's.
 */
function Badge({ className, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-variant="neutral"
      className={cn(
        'inline-flex items-center rounded-sm border border-border-strong bg-transparent px-2 py-0.5 text-caption font-medium whitespace-nowrap text-text-muted',
        className,
      )}
      {...props}
    />
  );
}

export { Badge, type BadgeProps };
