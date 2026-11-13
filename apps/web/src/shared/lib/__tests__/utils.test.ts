import { describe, expect, it } from 'vitest';
import { cn } from '../utils';

describe('cn', () => {
  it('lets a later utility override an earlier one of the same kind', () => {
    expect(cn('px-2 text-text', false, 'px-4 text-run-failed')).toBe('px-4 text-run-failed');
  });

  it('keeps a token colour next to a design-system font size', () => {
    expect(cn('text-run-failed', 'text-label')).toBe('text-run-failed text-label');
    expect(cn('text-body text-text-muted', 'text-small')).toBe('text-text-muted text-small');
  });

  it('knows the shadow tokens: shadow-float is a shadow size, not a colour', () => {
    expect(cn('shadow-float shadow-brand')).toBe('shadow-float shadow-brand');
    expect(cn('shadow-xs', 'shadow-float')).toBe('shadow-float');
  });

  it('knows the custom animation token', () => {
    expect(cn('animate-pulse', 'animate-pulse-dot')).toBe('animate-pulse-dot');
  });

  it('keeps radius tokens and token colours apart', () => {
    expect(cn('rounded-md', 'rounded-xl')).toBe('rounded-xl');
    expect(cn('bg-surface', 'bg-run-failed-soft')).toBe('bg-run-failed-soft');
    expect(cn('border-border-strong', 'border-2')).toBe('border-border-strong border-2');
  });
});
