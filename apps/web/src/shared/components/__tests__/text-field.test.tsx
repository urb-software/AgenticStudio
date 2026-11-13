import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TextField } from '../text-field';

describe('TextField', () => {
  it('wires the visible label and the help text to the input', async () => {
    const { container } = render(
      <TextField label="Repository URL" help="SSH (git@…) or HTTPS" mono />,
    );

    const input = screen.getByRole('textbox', { name: 'Repository URL' });
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'SSH (git@…) or HTTPS',
    );
    expect(input.getAttribute('aria-invalid')).toBeNull();
    // Mono is 13px only from tablet up; phones keep the 16px input font.
    expect(input.className.split(' ')).toEqual(
      expect.arrayContaining(['font-mono', 'md:text-[13px]', 'text-base']),
    );

    await userEvent.type(input, 'git@github.com:acme/shop.git');
    expect(input).toHaveProperty('value', 'git@github.com:acme/shop.git');
    await expect(container).toHaveNoAxeViolations();
  });

  it('replaces the help text with an announced error and marks the input invalid', async () => {
    const { container } = render(
      <TextField label="Name" help="Shown in the sidebar" error="Name is required" />,
    );

    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Name is required');
    expect(screen.queryByText('Shown in the sidebar')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    await expect(container).toHaveNoAxeViolations();
  });

  it('renders a labelled textarea when multiline', async () => {
    const { container } = render(<TextField label="Task" multiline rows={4} />);

    const textarea = screen.getByRole('textbox', { name: 'Task' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('rows')).toBe('4');
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps a caller id and description', () => {
    render(
      <>
        <p id="secret-note">Stored outside Git</p>
        <TextField
          id="token"
          label="Token"
          type="password"
          autoComplete="off"
          help="Write-only"
          aria-describedby="secret-note"
        />
      </>,
    );

    const input = screen.getByLabelText('Token');
    expect(input.id).toBe('token');
    expect(input.getAttribute('aria-describedby')).toBe('secret-note token-message');
  });
});
