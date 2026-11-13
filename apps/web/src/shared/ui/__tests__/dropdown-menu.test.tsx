import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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

  it('shows an inset 2px brand outline on every focused item kind, kept inside the scroll box', async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Show archived</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="name">
            <DropdownMenuRadioItem value="name">Sort by name</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Archive</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const items = [
      screen.getByRole('menuitem', { name: 'Rename' }),
      screen.getByRole('menuitemcheckbox', { name: 'Show archived' }),
      screen.getByRole('menuitemradio', { name: 'Sort by name' }),
      screen.getByRole('menuitem', { name: 'Move to' }),
    ];
    for (const item of items) {
      const classes = item.className.split(' ');
      expect(classes).toEqual(
        expect.arrayContaining([
          'focus-visible:outline-2',
          'focus-visible:-outline-offset-2',
          'focus-visible:outline-ring',
          'focus:bg-accent',
        ]),
      );
      expect(classes).not.toContain('outline-hidden');
    }
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('opens inside a given container instead of body', async () => {
    const container = document.createElement('section');
    document.body.append(container);
    try {
      render(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost">Open</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent container={container}>
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );

      await userEvent.click(screen.getByRole('button', { name: 'Open' }));

      expect(container.contains(screen.getByRole('menu'))).toBe(true);
    } finally {
      container.remove();
    }
  });
});
