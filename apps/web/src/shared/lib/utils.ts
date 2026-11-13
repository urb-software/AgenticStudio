import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must know the type scale of globals.css (`--text-*`): otherwise it reads
 * `text-label` as a colour and drops a `text-run-failed` next to it.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['page-title', 'section-title', 'body', 'label', 'small', 'caption', 'code'],
    },
  },
});

/** Joins class names and lets later Tailwind utilities override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
