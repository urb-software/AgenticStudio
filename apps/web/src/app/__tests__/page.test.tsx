import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StudioPage from '../page';

describe('StudioPage', () => {
  it('shows the Studio heading and the placeholder notice', () => {
    render(<StudioPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'AI Agent Studio' })).toBeTruthy();
    expect(screen.getByText(/placeholder studio page/i)).toBeTruthy();
  });
});
