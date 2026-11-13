import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusPill } from '../status-pill';

describe('StatusPill', () => {
  it.each([
    ['queued', 'Queued'],
    ['running', 'Running'],
    ['awaiting', 'Awaiting'],
    ['succeeded', 'Succeeded'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
    ['none', 'No runs yet'],
  ] as const)('shows the %s state with its word, not colour alone', async (status, label) => {
    const { container } = render(<StatusPill status={status} />);

    const pill = screen.getByText(label);
    expect(pill.dataset.status).toBe(status);
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps the colour of the state when the label is overridden', () => {
    render(<StatusPill status="succeeded">Connected</StatusPill>);

    const pill = screen.getByText('Connected');
    expect(pill.dataset.status).toBe('succeeded');
    expect(pill.className).toContain('pill-succeeded');
  });
});
