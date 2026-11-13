import * as React from 'react';
import { inputClassName } from '@/shared/ui/input';
import { cn } from '@/shared/lib/utils';

/** Multi-line text control with the Input recipe (TextField `multiline`). */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(inputClassName, 'min-h-16 resize-y py-2.5 leading-normal', className)}
      {...props}
    />
  );
}

export { Textarea };
