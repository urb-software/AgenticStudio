import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogoLockup, LogoMark } from '../logo-mark';

describe('LogoMark', () => {
  it('is decorative: hidden from assistive technology, with no axe violations', async () => {
    const { container } = render(<LogoMark />);

    const mark = container.querySelector('span');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.querySelector('svg')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('LogoLockup', () => {
  it('sets the product name beside the decorative mark', async () => {
    const { container } = render(<LogoLockup />);

    const name = screen.getByText('Agent Studio');
    expect(name.className).toContain('text-[15px]');
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('can show the mark alone (collapsed sidebar rail)', () => {
    const { container } = render(<LogoLockup showLabel={false} />);

    expect(screen.queryByText('Agent Studio')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
  });

  it('passes classes to the label, e.g. to hide it at some widths', () => {
    render(<LogoLockup labelClassName="md:max-xl:hidden" />);

    expect(screen.getByText('Agent Studio').className).toContain('md:max-xl:hidden');
  });
});
