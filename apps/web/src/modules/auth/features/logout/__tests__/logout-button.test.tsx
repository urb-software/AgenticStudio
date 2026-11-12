import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogoutButton } from '../logout-button';

describe('LogoutButton', () => {
  it('offers an enabled sign-out button', () => {
    render(<LogoutButton />);

    const button = screen.getByRole('button', { name: 'Sign out' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
