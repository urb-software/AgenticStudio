import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../badge';

describe('Badge', () => {
  it('labels an identity in the neutral variant and has no axe violations', async () => {
    const { container } = render(<Badge>Definitions Repository</Badge>);

    expect(screen.getByText('Definitions Repository').dataset.variant).toBe('neutral');
    await expect(container).toHaveNoAxeViolations();
  });

  it('marks what is unusable with the danger tone and has no axe violations', async () => {
    const { container } = render(<Badge tone="danger">Not usable</Badge>);

    expect(screen.getByText('Not usable').dataset.tone).toBe('danger');
    await expect(container).toHaveNoAxeViolations();
  });
});
