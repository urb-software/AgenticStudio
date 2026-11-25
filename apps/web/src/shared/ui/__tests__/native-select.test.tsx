import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Label } from '../label';
import { NativeSelect } from '../native-select';

describe('NativeSelect', () => {
  it('chooses an option and is labelled by its label', async () => {
    const { container } = render(
      <>
        <Label htmlFor="agent">Agent</Label>
        <NativeSelect id="agent" defaultValue="a">
          <option value="a">A</option>
          <option value="b">B</option>
        </NativeSelect>
      </>,
    );

    const select = screen.getByRole('combobox', { name: 'Agent' });
    await userEvent.selectOptions(select, 'b');
    expect(select).toHaveProperty('value', 'b');
    await expect(container).toHaveNoAxeViolations();
  });

  it('uses the text control recipe: edge, fill, ring focus, 38px and invalid edge', () => {
    render(
      <NativeSelect aria-label="Agent" aria-invalid>
        <option>A</option>
      </NativeSelect>,
    );

    const select = screen.getByRole('combobox', { name: 'Agent' });
    expect(select.className.split(' ')).toEqual(
      expect.arrayContaining([
        'border-input',
        'bg-bg-subtle',
        'h-[38px]',
        'aria-invalid:border-run-failed',
      ]),
    );
    expect(select.getAttribute('aria-invalid')).toBe('true');
  });
});
