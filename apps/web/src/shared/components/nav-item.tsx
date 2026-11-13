import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

type NavItemOwnProps = {
  icon: LucideIcon;
  label: string;
  /** The current page: brand-soft fill, brand icon, aria-current="page". */
  active?: boolean;
  /** Amber count of items waiting on the operator; part of the accessible name. */
  badge?: number | string;
  /**
   * `true`: the 64px icon rail; the label becomes the tooltip, and the label (with the badge
   * count) the aria-label. `'tablet'`: the rail drawn by CSS alone at tablet width (768–1279px),
   * for a server render that cannot know the width yet; the label and badge stay in the DOM,
   * visually hidden, so they remain the accessible name. No tooltip until JS decides.
   */
  collapsed?: boolean | 'tablet';
  className?: string;
};

type NavItemProps = NavItemOwnProps &
  (
    | ({ href: string } & Omit<React.ComponentProps<typeof Link>, keyof NavItemOwnProps | 'href'>)
    | ({ href?: undefined } & Omit<React.ComponentProps<'button'>, keyof NavItemOwnProps>)
  );

/**
 * Sidebar navigation row (design-system/components/NavItem): icon, label and an optional count
 * badge. A link when it has an `href`, else a button.
 */
function NavItem({
  icon: Icon,
  label,
  active = false,
  badge,
  collapsed = false,
  className,
  ...props
}: NavItemProps) {
  const rail = collapsed === true;
  const tabletRail = collapsed === 'tablet';
  const classes = cn(
    'flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-label font-medium text-text-muted',
    'cursor-pointer no-underline transition-colors hover:bg-hover hover:text-text',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'pointer-coarse:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0',
    active && 'bg-brand-soft text-text hover:bg-brand-soft [&_svg]:text-brand',
    rail && 'justify-center',
    tabletRail && 'md:max-xl:justify-center',
    className,
  );
  const content = (
    <>
      <Icon aria-hidden="true" />
      {rail ? null : (
        <span className={cn('truncate', tabletRail && 'md:max-xl:sr-only')}>{label}</span>
      )}
      {badge !== undefined && !rail ? (
        // The space keeps the accessible name readable ("Executions 2"); flex ignores it.
        <>
          {' '}
          <span
            className={cn(
              'ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-run-awaiting-soft px-[5px] text-[11px] font-semibold text-run-awaiting',
              tabletRail && 'md:max-xl:sr-only',
            )}
          >
            {badge}
          </span>
        </>
      ) : null}
    </>
  );
  const wiring = {
    'data-slot': 'nav-item',
    'data-active': active,
    'aria-current': active ? ('page' as const) : undefined,
    // The rail hides the badge, so its count stays in the name ("Runs, 3").
    'aria-label': rail ? (badge !== undefined ? `${label}, ${badge}` : label) : undefined,
    className: classes,
  };
  const item =
    props.href !== undefined ? (
      <Link {...props} {...wiring}>
        {content}
      </Link>
    ) : (
      <button type="button" {...props} {...wiring}>
        {content}
      </button>
    );

  if (!rail) return item;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export { NavItem, type NavItemProps };
