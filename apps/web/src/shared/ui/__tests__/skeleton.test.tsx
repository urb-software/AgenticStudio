import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Skeleton } from '../skeleton';

describe('Skeleton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps its space but shows only after about 150ms, hidden from assistive technology', async () => {
    const { container } = render(<Skeleton className="h-3 w-40" />);
    const skeleton = container.querySelector('[data-slot="skeleton"]');

    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton?.className).toContain('invisible');

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(skeleton?.className).toContain('invisible');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(skeleton?.className).not.toContain('invisible');
    expect(skeleton?.className).toContain('h-3');

    vi.useRealTimers();
    await expect(container).toHaveNoAxeViolations();
  });
});
