import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffView } from '../diff-view';

const LINES = [
  { type: 'hunk' as const, text: '@@ -1,2 +1,2 @@' },
  { type: 'ctx' as const, old: 1, new: 1, text: 'keep' },
  { type: 'del' as const, old: 2, text: 'old' },
  { type: 'add' as const, new: 2, text: '<b>new</b>' },
];

describe('DiffView', () => {
  it('shows the path and counts, and each row with its line numbers, sign and text', async () => {
    const { container } = render(<DiffView path="src/a.ts" lines={LINES} />);

    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    const rows = [...container.querySelectorAll<HTMLElement>('[data-type]')];
    expect(rows.map((row) => [...row.children].map((cell) => cell.textContent))).toEqual([
      ['', '', '', '@@ -1,2 +1,2 @@'],
      ['1', '1', '', 'keep'],
      ['2', '', '−', 'old'],
      ['', '2', '+', '<b>new</b>'],
    ]);
    // Additions and deletions on the run-state fills.
    expect(rows[3]!.className).toContain('bg-run-succeeded-soft');
    expect(rows[2]!.className).toContain('bg-run-failed-soft');
    expect(rows[0]!.className).toContain('bg-run-running-soft');
    // Plain text: the markup in a line is not rendered.
    expect(container.querySelector('b')).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('scrolls sideways in its own focusable, named box', () => {
    render(<DiffView path="src/a.ts" lines={LINES} />);

    const box = screen.getByRole('region', { name: 'Diff of src/a.ts' });
    expect(box.tabIndex).toBe(0);
    expect(box.className).toContain('overflow-x-auto');
  });

  it('has no header without a path', () => {
    render(<DiffView lines={LINES} label="Changes" />);

    expect(screen.queryByText('+1')).toBeNull();
    expect(screen.getByRole('region', { name: 'Changes' })).toBeTruthy();
  });
});
