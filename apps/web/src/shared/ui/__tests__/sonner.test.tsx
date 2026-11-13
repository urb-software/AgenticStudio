import { act, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it } from 'vitest';
import { Toaster } from '../sonner';

describe('Toaster', () => {
  afterEach(() => {
    act(() => {
      toast.dismiss();
    });
  });

  it('announces a confirmation with its description in a labelled bottom-right region', async () => {
    const { container } = render(<Toaster />);

    act(() => {
      toast.success('Project created', { description: 'acme-shop' });
    });

    expect(await screen.findByText('Project created')).toBeTruthy();
    expect(screen.getByText('acme-shop')).toBeTruthy();
    const region = screen.getByRole('region', { name: /notifications/i });
    expect(region.querySelector('[data-sonner-toaster]')?.getAttribute('data-y-position')).toBe(
      'bottom',
    );
    expect(region.querySelector('[data-sonner-toaster]')?.getAttribute('data-x-position')).toBe(
      'right',
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows at most four toasts at a time', async () => {
    render(<Toaster />);

    act(() => {
      for (let i = 1; i <= 6; i++) toast(`Merged to dev ${i}`);
    });

    await screen.findByText('Merged to dev 6');
    const visible = document.querySelectorAll('[data-sonner-toast][data-visible="true"]');
    expect(visible).toHaveLength(4);
  });
});
