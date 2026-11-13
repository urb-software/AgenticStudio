import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

type IconButtonProps = Omit<React.ComponentProps<'button'>, 'children' | 'aria-label'> & {
  icon: LucideIcon;
  /** Required: the accessible name and the tooltip. */
  label: string;
  /** 36px default, 28px `sm` inside rows and dialog headers (44px on coarse pointers). */
  size?: 'sm' | 'md';
  /** Unread marker (notifications). */
  dot?: boolean;
};

/**
 * Icon-only button (design-system/components/IconButton) for the top bar, dialog close and row
 * actions: muted icon at rest, `text` on hover. Never the primary action of a page.
 */
function IconButton({
  icon: Icon,
  label,
  size = 'md',
  dot = false,
  className,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={size === 'sm' ? 'icon-sm' : 'icon'}
          aria-label={label}
          className={cn('relative text-text-muted hover:text-text', className)}
          {...props}
        >
          <Icon aria-hidden="true" />
          {dot ? (
            <span
              data-slot="icon-button-dot"
              aria-hidden="true"
              className="absolute top-[7px] right-[7px] size-2 rounded-full border-2 border-bg bg-brand-solid"
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export { IconButton, type IconButtonProps };
