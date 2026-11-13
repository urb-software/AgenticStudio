'use client';

import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

/**
 * Agent Studio Dialog (design-system/components/Dialog): one decision or one short form. Radix
 * traps focus, moves it to the first field and closes on Esc or a backdrop click. Below 768px
 * it is a bottom sheet (frontend.md §9): the body scrolls and the footer actions stay in view.
 */
function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // The design system has no overlay token: the scrim is black at 55% in both themes.
        'fixed inset-0 z-50 bg-black/55 duration-150 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  destructive = false,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Destructive confirms are announced as an alertdialog. */
  destructive?: boolean;
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        role={destructive ? 'alertdialog' : 'dialog'}
        className={cn(
          // Phone: bottom sheet.
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] w-full flex-col',
          'rounded-t-xl border border-b-0 border-border-strong bg-surface text-body text-text shadow-float',
          'duration-150 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2',
          // Tablet and desktop: centred card near the top.
          'md:inset-x-auto md:top-[10vh] md:bottom-auto md:left-1/2 md:max-h-[80vh] md:max-w-[460px] md:-translate-x-1/2 md:rounded-xl md:border-b',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              className="absolute top-3 right-3 text-text-muted hover:text-text"
            >
              <XIcon />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-none flex-col px-5 pt-[18px] pr-12 pb-4', className)}
      {...props}
    />
  );
}

/** What will happen: the scrollable part of the dialog. */
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-4', className)}
      {...props}
    />
  );
}

/** Actions: ghost "Cancel" on the left of the confirm. Sticky, so it stays in view. */
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'sticky bottom-0 flex flex-none flex-wrap items-center justify-end gap-2',
        'border-t border-border bg-bg-subtle px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]',
        'md:rounded-b-xl',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('m-0 text-section-title font-semibold', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('mt-1 text-small text-text-muted', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
