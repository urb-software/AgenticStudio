import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu';

function OperatorMenu({ onSignOut }: { onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost">Operator</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>operator@studio</DropdownMenuLabel>
        <DropdownMenuItem>Settings</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe('DropdownMenu', () => {
  it('opens from the keyboard, moves through items and selects one', async () => {
    const onSignOut = vi.fn();
    render(<OperatorMenu onSignOut={onSignOut} />);

    await userEvent.tab();
    await userEvent.keyboard('{Enter}');

    const menu = screen.getByRole('menu');
    expect(menu).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Sign out' }));
    await userEvent.keyboard('{Enter}');

    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click (no hover needed), closes on Esc and has 44px items on coarse pointers', async () => {
    render(<OperatorMenu onSignOut={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Operator' });

    await userEvent.click(trigger);
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item.className).toContain('pointer-coarse:min-h-11');
    }

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
