import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '@/shared/ui/button';
import { Banner, type BannerTone } from '../banner';

describe('Banner', () => {
  it('announces a server error as an alert, leading with the bold title', async () => {
    const { container } = render(
      <Banner
        tone="danger"
        title="Repository unreachable."
        action={<Button size="sm">Retry</Button>}
      >
        git ls-remote timed out after 30s.
      </Banner>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.querySelector('b')?.textContent?.trim()).toBe('Repository unreachable.');
    expect(alert.textContent).toContain('git ls-remote timed out after 30s.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it.each<BannerTone>(['info', 'warning', 'success'])(
    'reports the %s tone as status with an icon',
    async (tone) => {
      const { container } = render(
        <Banner tone={tone} title="Merged to dev">
          as c81d0e4
        </Banner>,
      );

      const status = screen.getByRole('status');
      expect(status.dataset.tone).toBe(tone);
      expect(status.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      await expect(container).toHaveNoAxeViolations();
    },
  );

  it('defaults to info', () => {
    render(<Banner>Preview rebuilding</Banner>);

    expect(screen.getByRole('status').dataset.tone).toBe('info');
  });
});
