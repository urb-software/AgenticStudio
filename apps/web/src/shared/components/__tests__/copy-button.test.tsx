import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../copy-button';

describe('CopyButton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies the value to the clipboard and confirms it in words, for screen readers too', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CopyButton value="ssh-ed25519 example-public-key studio-shop" label="Copy public key" />,
    );

    await user.click(screen.getByRole('button', { name: 'Copy public key' }));

    expect(await navigator.clipboard.readText()).toBe('ssh-ed25519 example-public-key studio-shop');
    expect(screen.getByRole('button').textContent).toMatch(/Copied/);
    expect(screen.getByRole('status').textContent).toBe('Copied to the clipboard.');
    await expect(container).toHaveNoAxeViolations();
  });

  it('goes back to "Copy" after a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    render(<CopyButton value="x" label="Copy value" />);

    await user.click(screen.getByRole('button', { name: 'Copy value' }));
    expect(screen.getByRole('button').textContent).toMatch(/Copied/);
    act(() => {
      vi.advanceTimersByTime(2_500);
    });

    expect(screen.getByRole('button').textContent).toMatch(/^Copy$/);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('says so when the clipboard is not available, so the value can be selected instead', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    render(<CopyButton value="x" label="Copy value" />);

    await user.click(screen.getByRole('button', { name: 'Copy value' }));

    expect(screen.getByRole('status').textContent).toBe(
      'Could not copy. Select the text and copy it instead.',
    );
  });
});
