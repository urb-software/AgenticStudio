import * as React from 'react';
import { CheckIcon, InfoIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

type BannerTone = 'info' | 'warning' | 'danger' | 'success';

type BannerProps = {
  tone?: BannerTone;
  /** Bold summary that leads the message (for server errors: the problem+json title). */
  title?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
};

const TONE_CLASS: Record<BannerTone, string> = {
  info: 'border-run-running/30 bg-run-running-soft text-run-running',
  warning: 'border-run-awaiting/30 bg-run-awaiting-soft text-run-awaiting',
  danger: 'border-run-failed/30 bg-run-failed-soft text-run-failed',
  success: 'border-run-succeeded/30 bg-run-succeeded-soft text-run-succeeded',
};

const TONE_ICON: Record<BannerTone, LucideIcon> = {
  info: InfoIcon,
  warning: TriangleAlertIcon,
  danger: TriangleAlertIcon,
  success: CheckIcon,
};

/**
 * Inline, persistent message inside a page, card, dialog or drawer
 * (design-system/components/Banner); it stays until the condition changes. `danger` is
 * announced as an alert, the other tones as status. Transient confirmations use a toast.
 */
function Banner({ tone = 'info', title, icon, action, children, className }: BannerProps) {
  const Icon = icon ?? TONE_ICON[tone];

  return (
    <div
      data-slot="banner"
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-small',
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span className="min-w-0 flex-auto">
        {title ? <b className="font-semibold">{title} </b> : null}
        {children}
      </span>
      {action}
    </div>
  );
}

export { Banner, type BannerProps, type BannerTone };
