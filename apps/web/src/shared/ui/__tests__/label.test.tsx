import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Label } from '../label';

describe('Label', () => {
  it('names its control and moves focus to it when clicked', async () => {
    const { container } = render(
      <>
        <Label htmlFor="branch">Branch</Label>
        <input id="branch" />
      </>,
    );

    await userEvent.click(screen.getByText('Branch'));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Branch' }));
    await expect(container).toHaveNoAxeViolations();
  });
});
