import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Bell, X } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from '../icon-button';

describe('IconButton', () => {
  it('is named by its label, which is also its tooltip on keyboard focus', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <IconButton icon={Bell} label="Notifications" onClick={onClick} />,
    );

    await userEvent.tab();
    const button = screen.getByRole('button', { name: 'Notifications' });
    expect(document.activeElement).toBe(button);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Notifications');
    await expect(container).toHaveNoAxeViolations();

    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is 36px by default, 28px small, 44px on coarse pointers, and shows the unread dot', () => {
    render(
      <>
        <IconButton icon={Bell} label="Notifications" dot />
        <IconButton icon={X} label="Dismiss" size="sm" />
      </>,
    );

    const bell = screen.getByRole('button', { name: 'Notifications' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(bell.className.split(' ')).toEqual(
      expect.arrayContaining(['size-9', 'pointer-coarse:min-h-11', 'pointer-coarse:min-w-11']),
    );
    expect(dismiss.className.split(' ')).toContain('size-7');
    expect(bell.querySelector('[data-slot="icon-button-dot"]')).toBeTruthy();
    expect(dismiss.querySelector('[data-slot="icon-button-dot"]')).toBeNull();
  });

  it('does not compile without a label', () => {
    // @ts-expect-error the label (accessible name) is required
    const element = <IconButton icon={Bell} />;
    expect(element).toBeTruthy();
  });
});
