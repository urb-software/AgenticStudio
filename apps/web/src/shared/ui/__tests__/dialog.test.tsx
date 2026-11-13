import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from '../button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../dialog';

function NewProjectDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="primary">New project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Projects group repositories, agents and runs.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="project-name">Name</label>
          <input id="project-name" />
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary">Create project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opens as a modal dialog, focuses the first field and has no axe violations', async () => {
    render(<NewProjectDialog />);

    await userEvent.click(screen.getByRole('button', { name: 'New project' }));

    const dialog = screen.getByRole('dialog', { name: 'New project' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('traps focus inside the dialog', async () => {
    render(<NewProjectDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog');

    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Esc and returns focus to the trigger', async () => {
    render(<NewProjectDialog />);
    const trigger = screen.getByRole('button', { name: 'New project' });
    await userEvent.click(trigger);

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes from the labelled close button', async () => {
    render(<NewProjectDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is an alertdialog for destructive confirms', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent destructive>
          <DialogHeader>
            <DialogTitle>Cancel r-1043?</DialogTitle>
            <DialogDescription>The worktree and branch are kept.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Keep it</Button>
            </DialogClose>
            <Button variant="destructive">Cancel run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole('alertdialog', { name: 'Cancel r-1043?' })).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('is a bottom sheet below 768px with a scrollable body and sticky actions', async () => {
    render(<NewProjectDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));

    const classes = (selector: string) =>
      document.querySelector(`[data-slot="${selector}"]`)?.className.split(' ') ?? [];
    // Unprefixed classes apply below the md (768px) breakpoint.
    expect(classes('dialog-content')).toEqual(
      expect.arrayContaining(['fixed', 'inset-x-0', 'bottom-0', 'max-h-[90dvh]', 'rounded-t-xl']),
    );
    expect(classes('dialog-content')).toEqual(
      expect.arrayContaining(['md:top-[10vh]', 'md:max-w-[460px]', 'md:rounded-xl']),
    );
    expect(classes('dialog-body')).toEqual(
      expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']),
    );
    expect(classes('dialog-footer')).toEqual(expect.arrayContaining(['sticky', 'bottom-0']));
  });
});
