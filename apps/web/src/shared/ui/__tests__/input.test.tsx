import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Input } from '../input';
import { Label } from '../label';

describe('Input', () => {
  it('takes typed text and is labelled by its label', async () => {
    const { container } = render(
      <>
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="acme-shop" />
      </>,
    );

    const input = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.type(input, 'acme-shop');
    expect(input).toHaveProperty('value', 'acme-shop');
    await expect(container).toHaveNoAxeViolations();
  });

  it('is visible in both themes, focuses with the ring colour and sizes for phones', () => {
    render(<Input aria-label="Repository URL" />);

    const classes = screen.getByRole('textbox', { name: 'Repository URL' }).className.split(' ');
    // Edge from --input (border-strong), focus outline from --ring.
    expect(classes).toEqual(
      expect.arrayContaining([
        'border-input',
        'bg-bg-subtle',
        'focus-visible:outline-2',
        'focus-visible:outline-offset-2',
        'focus-visible:outline-ring',
      ]),
    );
    // 16px below 768px (no zoom on focus), 44px on coarse pointers.
    expect(classes).toEqual(
      expect.arrayContaining(['text-base', 'md:text-body', 'pointer-coarse:min-h-11']),
    );
  });

  it('marks an invalid value for assistive technology', async () => {
    const { container } = render(<Input aria-label="Name" aria-invalid="true" />);

    expect(screen.getByRole('textbox', { name: 'Name' }).getAttribute('aria-invalid')).toBe('true');
    await expect(container).toHaveNoAxeViolations();
  });
});
