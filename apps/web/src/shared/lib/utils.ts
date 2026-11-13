import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must know the custom scales of globals.css: the type scale (`--text-*`),
 * the shadows (`--shadow-xs`, `--shadow-float`) and the `pulse-dot` animation. Otherwise it
 * reads `text-label` or `shadow-float` as a colour and drops the real colour next to it.
 * Radius tokens (sm–xl) and colour tokens need no entry: their names already classify.
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

/** Joins class names and lets later Tailwind utilities override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
