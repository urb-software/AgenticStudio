import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from '../segmented-control';

const OPTIONS = [
  { value: 'grid', label: 'Grid' },
  { value: 'table', label: 'Table' },
] as const;

function Controlled({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState<string>('grid');
  return (
    <SegmentedControl
      label="View"
      options={OPTIONS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('SegmentedControl', () => {
  it('is a labelled group whose selected option is pressed', async () => {
    const { container } = render(<Controlled />);

    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Table' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it('selects another option on click and reports it', async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'Table' }));

    expect(onChange).toHaveBeenCalledWith('table');
    expect(screen.getByRole('button', { name: 'Table' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('locks every option when disabled', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="View" options={OPTIONS} value="grid" onChange={onChange} disabled />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Table' }));

    expect(screen.getByRole('button', { name: 'Table' })).toHaveProperty('disabled', true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can be named by a visible label instead', () => {
    render(
      <>
        <span id="provider-label">Provider</span>
        <SegmentedControl
          aria-labelledby="provider-label"
          options={OPTIONS}
          value="grid"
          onChange={() => {}}
        />
      </>,
    );

    expect(screen.getByRole('group', { name: 'Provider' })).toBeTruthy();
  });

  it('disables a single option, described by its reason, and never selects it', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <>
        <SegmentedControl
          label="Provider"
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta', disabled: true, describedBy: 'beta-reason' },
          ]}
          value="a"
          onChange={onChange}
        />
        <p id="beta-reason">Beta is switched off.</p>
      </>,
    );
    const beta = screen.getByRole('button', { name: 'Beta' });

    await userEvent.click(beta);

    expect(beta).toHaveProperty('disabled', true);
    expect(beta.getAttribute('aria-describedby')).toBe('beta-reason');
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveProperty('disabled', false);
    expect(onChange).not.toHaveBeenCalled();
    await expect(container).toHaveNoAxeViolations();
  });
});
