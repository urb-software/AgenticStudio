import { cn } from '@/shared/lib/utils';

/**
 * The Agent Studio mark: the hexagon in a violet `brand-solid` tile (the design system's
 * `accent-solid`; design-system/assets/Logos, drawn as in the prototype). Decorative: the
 * product name is always set beside it. 30px tile: the `control-sm` size, which has no
 * Tailwind token in globals.css.
 */
export function LogoMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md bg-brand-solid text-on-brand"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3l7 4v10l-7 4-7-4V7z M12 8v8 M8.5 10l7 4 M15.5 10l-7 4" />
      </svg>
    </span>
  );
}

type LogoLockupProps = {
  /** `false`: the mark alone (the collapsed sidebar rail). */
  showLabel?: boolean;
  className?: string;
  labelClassName?: string;
};

/**
 * The logo lockup: the mark with the product name beside it, in the sidebar header and on the
 * login card. 15px semibold name (prototype `.logo-text`): no type token matches.
 */
export function LogoLockup({ showLabel = true, className, labelClassName }: LogoLockupProps) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <LogoMark />
      {showLabel ? (
        <span
          className={cn(
            'flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-text',
            labelClassName,
          )}
        >
          Agent Studio
        </span>
      ) : null}
    </span>
  );
}
