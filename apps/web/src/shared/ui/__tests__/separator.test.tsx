import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Separator } from '../separator';

describe('Separator', () => {
  it('is decorative by default and a separator when it carries meaning', async () => {
    const { container } = render(
      <>
        <Separator />
        <Separator decorative={false} orientation="vertical" />
      </>,
    );

    const separators = screen.getAllByRole('separator');
    expect(separators).toHaveLength(1);
    expect(separators[0]?.getAttribute('aria-orientation')).toBe('vertical');
    await expect(container).toHaveNoAxeViolations();
  });
});
