'use client';

import * as React from 'react';
import { cn } from '@/shared/lib/utils';

/** How long a load may take before the placeholder shows, so fast loads don't flash. */
const SHOW_AFTER_MS = 150;

/**
 * Loading placeholder (design-system/components/Skeleton), shaped by the caller like the content
 * it replaces. It keeps its space but stays invisible for the first ~150ms; the pulse stops
 * under reduced motion (globals.css).
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      data-slot="skeleton"
      data-visible={visible}
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-sm bg-linear-to-r from-surface-raised via-hover to-surface-raised',
        !visible && 'invisible',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
