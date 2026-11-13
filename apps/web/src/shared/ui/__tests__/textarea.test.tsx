import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Textarea } from '../textarea';

describe('Textarea', () => {
  it('takes multi-line text with the visible input recipe', async () => {
    const { container } = render(<Textarea aria-label="Review comment" rows={3} />);

    const textarea = screen.getByRole('textbox', { name: 'Review comment' });
    await userEvent.type(textarea, 'Rename the helper{enter}and add a test');
    expect(textarea).toHaveProperty('value', 'Rename the helper\nand add a test');
    expect(textarea.className.split(' ')).toEqual(
      expect.arrayContaining(['border-input', 'focus-visible:outline-ring', 'text-base']),
    );
    await expect(container).toHaveNoAxeViolations();
  });
});
