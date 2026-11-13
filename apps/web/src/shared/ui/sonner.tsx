'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, toast, type ToasterProps } from 'sonner';
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from 'lucide-react';

/**
 * Toaster for transient confirmations (design-system/components/Toast): bottom-right, up to
 * four at a time, auto-dismissed after about 4.5s. Errors that need action go in a Banner.
 * Sonner's colour variables point at the tokens through classNames (no style= colours); `!`
 * lets them win over Sonner's own unlayered stylesheet.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme === 'light' ? 'light' : 'dark'}
      position="bottom-right"
      visibleToasts={4}
      duration={4500}
      className="toaster group [--border-radius:var(--radius-lg)]! [--normal-bg:var(--surface)]! [--normal-border:var(--border-strong)]! [--normal-text:var(--text)]!"
      icons={{
        success: <CircleCheckIcon className="size-4 text-run-succeeded" />,
        info: <InfoIcon className="size-4 text-brand" />,
        warning: <TriangleAlertIcon className="size-4 text-run-awaiting" />,
        error: <OctagonXIcon className="size-4 text-run-failed" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: 'gap-2.5! text-label! shadow-float!',
          title: 'font-medium!',
          description: 'text-caption! text-text-dim!',
        },
      }}
      {...props}
    />
  );
};

// `toast` is re-exported so features show toasts through shared/ui, never sonner directly.
export { Toaster, toast };
