import * as React from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * Text control recipe of the TextField spec: 38px, `bg-subtle` fill and a `border-strong` edge
 * (shadcn `--input`), so the control is visible in both themes; the focus outline is the
 * `--ring` (brand) colour. Phones get a 16px font (no zoom on focus), coarse pointers 44px.
 */
const inputClassName = cn(
  'w-full min-w-0 rounded-md border border-input bg-bg-subtle px-3 text-base text-text md:text-body',
  'transition-colors placeholder:text-text-dim',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-invalid:border-run-failed',
  'pointer-coarse:min-h-11',
);

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        inputClassName,
        'h-[38px] file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-small file:font-medium file:text-text',
        className,
      )}
      {...props}
    />
  );
}

export { Input, inputClassName };
