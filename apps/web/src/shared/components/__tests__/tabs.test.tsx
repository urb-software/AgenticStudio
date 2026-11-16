import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';

function Example() {
  return (
    <Tabs defaultValue="log">
      <TabsList aria-label="Run">
        <TabsTrigger value="log">Log</TabsTrigger>
        <TabsTrigger value="changes">Changes</TabsTrigger>
      </TabsList>
      <TabsContent value="log">The log</TabsContent>
      <TabsContent value="changes">The changes</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('selects one tab at a time, by click or arrow key', async () => {
    const user = userEvent.setup();
    const { container } = render(<Example />);
    const log = screen.getByRole('tab', { name: 'Log' });
    const changes = screen.getByRole('tab', { name: 'Changes' });

    expect(log.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('The log');
    await user.click(changes);
    expect(changes.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('The changes');
    await user.keyboard('{ArrowLeft}');
    expect(log.getAttribute('aria-selected')).toBe('true');
    // The selected tab carries the accent underline.
    expect(log.className).toContain('data-[state=active]:border-brand-solid');
    await expect(container).toHaveNoAxeViolations();
  });
});
