import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TabPanel, Tabs } from '../tabs';

const ITEMS = [
  { value: 'log', label: 'Log' },
  { value: 'changes', label: 'Changes', count: 3, attention: true },
];

function Example({ onChange }: { onChange?: (value: string) => void }) {
  return (
    <Tabs items={ITEMS} label="Run" onChange={onChange}>
      <TabPanel value="log">The log</TabPanel>
      <TabPanel value="changes">The changes</TabPanel>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('selects one tab at a time, by click or arrow key, starting with the first', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<Example onChange={onChange} />);
    const log = screen.getByRole('tab', { name: 'Log' });
    const changes = screen.getByRole('tab', { name: /^Changes/ });

    expect(screen.getByRole('tablist', { name: 'Run' })).toBeTruthy();
    expect(log.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('The log');
    await user.click(changes);
    expect(changes.getAttribute('aria-selected')).toBe('true');
    expect(onChange).toHaveBeenLastCalledWith('changes');
    expect(screen.getByRole('tabpanel').textContent).toBe('The changes');
    await user.keyboard('{ArrowLeft}');
    expect(log.getAttribute('aria-selected')).toBe('true');
    // The selected tab carries the accent underline; a count that needs the operator is amber.
    expect(log.className).toContain('data-[state=active]:border-brand-solid');
    expect(screen.getByText('3').className).toContain('text-run-awaiting');
    await expect(container).toHaveNoAxeViolations();
  });
});
