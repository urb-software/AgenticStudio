import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitMerge, Plus } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../button';

const VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'destructive'] as const;

describe('Button', () => {
  it('is a secondary, medium, non-submitting button by default', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Connect repository</Button>);

    const button = screen.getByRole('button', { name: 'Connect repository' });
    expect(button).toHaveProperty('type', 'button');
    expect(button.dataset).toMatchObject({ variant: 'secondary', size: 'md' });

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(VARIANTS)('renders the %s variant without axe violations', async (variant) => {
    const { container } = render(
      <Button variant={variant} icon={Plus}>
        New project
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'New project' }).dataset.variant).toBe(variant);
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps the danger text colour next to the size font', () => {
    render(<Button variant="danger">Cancel run</Button>);

    expect(screen.getByRole('button', { name: 'Cancel run' }).className.split(' ')).toEqual(
      expect.arrayContaining(['text-run-failed', 'text-label', 'border-run-failed']),
    );
  });

  it('maps sizes to the control tokens and grows to 44px on coarse pointers', () => {
    render(
      <>
        <Button size="sm">Small</Button>
        <Button>Medium</Button>
        <Button size="lg">Sign in</Button>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Small' }).className).toContain('h-[30px]');
    expect(screen.getByRole('button', { name: 'Medium' }).className).toContain('h-9');
    expect(screen.getByRole('button', { name: 'Sign in' }).className).toContain('h-11');
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('pointer-coarse:min-h-11');
    }
  });

  it('shows a busy, disabled button while loading and swaps the icon for a spinner', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button variant="primary" icon={GitMerge} loading onClick={onClick}>
        Merging…
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Merging…' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(button.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    await expect(container).toHaveNoAxeViolations();
  });

  it('names an icon-only button by its required aria-label and shows a visible focus ring', async () => {
    const { container } = render(
      <Button size="icon" variant="ghost" aria-label="Notifications">
        <Plus />
      </Button>,
    );

    await userEvent.tab();
    const button = screen.getByRole('button', { name: 'Notifications' });
    expect(document.activeElement).toBe(button);
    expect(button.className).toContain('focus-visible:outline-2');
    expect(button.className).toContain('focus-visible:outline-offset-2');
    await expect(container).toHaveNoAxeViolations();
  });

  it('does not compile an icon-only button without an aria-label', () => {
    // @ts-expect-error icon sizes require an aria-label
    const element = <Button size="icon-sm" />;
    expect(element).toBeTruthy();
  });

  it('renders a link with button styling via asChild', () => {
    render(
      <Button asChild variant="ghost">
        <a href="/projects/acme-shop/preview">Open preview</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Open preview' });
    expect(link.dataset.variant).toBe('ghost');
    expect(link.hasAttribute('type')).toBe(false);
  });
});
