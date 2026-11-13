import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';

describe('Tooltip', () => {
  it('shows on keyboard focus without an app-level provider and hides on Esc', async () => {
    const { container } = render(
      <Tooltip>
        <TooltipTrigger>Run status</TooltipTrigger>
        <TooltipContent>2 running · 1 awaiting approval</TooltipContent>
      </Tooltip>,
    );

    await userEvent.tab();

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      '2 running · 1 awaiting approval',
    );
    await expect(container).toHaveNoAxeViolations();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
