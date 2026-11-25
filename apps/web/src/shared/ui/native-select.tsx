import * as React from 'react';
import { cn } from '@/shared/lib/utils';
import { inputClassName } from './input';

/**
 * A native `<select>` with the text control recipe of {@link Input} (the design system has no
 * Select component yet): same edge, fill, focus ring and invalid edge, 38px high. The browser's
 * own list keeps keyboard and screen reader behaviour.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(inputClassName, 'h-[38px]', className)}
      {...props}
    />
  );
}

export { NativeSelect };
