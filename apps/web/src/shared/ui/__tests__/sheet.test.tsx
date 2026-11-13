import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../sheet';

describe('Sheet', () => {
  it('opens from its trigger, traps focus, and closes from the labelled close button', async () => {
    render(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Filters</Button>
        </SheetTrigger>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription>Narrow the run list.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.tab();
    expect(sheet.contains(document.activeElement)).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
