import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2Icon, type LucideIcon } from 'lucide-react';
import { Slot } from 'radix-ui';
import { cn } from '@/shared/lib/utils';

/**
 * Agent Studio Button (design-system/components/Button). shadcn's `default` variant is the
 * design system's `primary`; the default is `secondary`, as the spec says (primary appears at
 * most once per view). Sizes follow the control tokens: sm 30px, md 36px, lg 44px; `icon` and
 * `icon-sm` are the 36px / 28px squares of the IconButton spec. On coarse pointers every size
 * grows to at least 44px.
 */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-medium whitespace-nowrap',
    'cursor-pointer transition-colors select-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    'pointer-coarse:min-h-11',
  ],
  {
    variants: {
      variant: {
        primary:
          'border-brand-solid bg-brand-solid text-on-brand hover:border-brand-solid-hover hover:bg-brand-solid-hover',
        secondary: 'border-border-strong bg-surface text-text hover:bg-hover',
        ghost: 'border-transparent bg-transparent text-text hover:bg-hover',
        danger: 'border-run-failed bg-transparent text-run-failed hover:bg-run-failed-soft',
        // The spec draws white text on danger-solid; on-brand is the white token of both themes.
        destructive: 'border-danger-solid bg-danger-solid text-on-brand hover:brightness-90',
      },
      size: {
        sm: "h-[30px] gap-1.5 px-2.5 text-[12.5px] [&_svg:not([class*='size-'])]:size-3.5",
        md: 'h-9 px-3.5 text-label',
        lg: 'h-11 px-[18px] text-[14.5px]',
        icon: 'size-9 pointer-coarse:min-w-11',
        'icon-sm': 'size-7 pointer-coarse:min-w-11',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;

type ButtonBaseProps = Omit<React.ComponentProps<'button'>, 'aria-label'> & {
  variant?: ButtonVariant;
  /** lucide icon before the label; `loading` swaps it for a spinner. */
  icon?: LucideIcon;
  /** lucide icon after the label. */
  iconRight?: LucideIcon;
  /** Shows a spinner, disables the button and sets aria-busy. The caller changes the label. */
  loading?: boolean;
  /** Renders the single child (e.g. a link) with the button's styling. */
  asChild?: boolean;
};

/** An icon-only button has no visible text, so its accessible name is required. */
type ButtonProps = ButtonBaseProps &
  (
    | { size?: 'sm' | 'md' | 'lg'; 'aria-label'?: string }
    | { size: 'icon' | 'icon-sm'; 'aria-label': string }
  );

function Button({
  className,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  asChild = false,
  type,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const leading = loading ? (
    <Loader2Icon aria-hidden="true" className="animate-spin" />
  ) : Icon ? (
    <Icon aria-hidden="true" />
  ) : null;

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      // A plain button never submits a form by accident; a submit button says so.
      type={asChild ? type : (type ?? 'button')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {leading}
      <Slot.Slottable>{children}</Slot.Slottable>
      {IconRight ? <IconRight aria-hidden="true" /> : null}
    </Comp>
  );
}

export { Button, buttonVariants, type ButtonProps };
