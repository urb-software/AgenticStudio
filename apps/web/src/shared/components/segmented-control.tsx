'use client';

import * as React from 'react';
import { cn } from '@/shared/lib/utils';

type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /**
   * Makes this option unavailable (e.g. a switched-off provider): it stays focusable, so its
   * reason (`describedBy`) is announced, but it cannot be selected (`aria-disabled`).
   */
  disabled?: boolean;
  /** Id of the text that says why it is locked (`aria-describedby`). */
  describedBy?: string;
};

type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name, when no visible label names it (`aria-labelledby`). */
  label?: string;
  /** Locks every option (e.g. while the form is submitting). */
  disabled?: boolean;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  className?: string;
};

/**
 * Two to four mutually exclusive options that switch a view or a single setting
 * (design-system/components/SegmentedControl): a group of buttons on the raised track, the
 * selected one on a surface thumb with `aria-pressed`. On coarse pointers each option grows to
 * 44px.
 */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  return (
    <div
      data-slot="segmented-control"
      role="group"
      aria-label={label}
      aria-labelledby={aria['aria-labelledby']}
      aria-describedby={aria['aria-describedby']}
      className={cn(
        'inline-flex gap-0.5 self-start rounded-[9px] border border-border bg-surface-raised p-[3px]',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-describedby={option.describedBy}
            aria-disabled={option.disabled ? true : undefined}
            disabled={disabled}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            className={cn(
              'inline-flex h-7 min-w-[30px] cursor-pointer items-center justify-center gap-1.5 rounded-sm border px-2.5 text-code font-medium',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              'disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11',
              'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
              selected
                ? 'border-border bg-surface text-text shadow-xs'
                : 'border-transparent bg-transparent text-text-muted hover:text-text',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export { SegmentedControl, type SegmentedControlProps, type SegmentedOption };
