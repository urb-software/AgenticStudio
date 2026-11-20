import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must know the custom scales of globals.css (`--text-*`, `--shadow-*`, the
 * `pulse-dot` animation); otherwise it reads `text-label` or `shadow-float` as a colour and
 * drops the real colour next to it.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['page-title', 'section-title', 'body', 'label', 'small', 'caption', 'code'],
      shadow: ['xs', 'float'],
      animate: ['pulse-dot'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
