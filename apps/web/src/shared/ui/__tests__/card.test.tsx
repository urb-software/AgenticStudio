import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../card';

describe('Card', () => {
  it('is a region named by its title, with header actions and a padded body', async () => {
    const { container } = render(
      <Card aria-labelledby="repo-title">
        <CardHeader>
          <CardTitle id="repo-title">Repository</CardTitle>
          <CardAction>
            <Button size="sm">Disconnect</Button>
          </CardAction>
        </CardHeader>
        <CardContent>git@github.com:acme/shop.git</CardContent>
      </Card>,
    );

    const card = screen.getByRole('region', { name: 'Repository' });
    expect(within(card).getByRole('heading', { name: 'Repository' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.getByText('git@github.com:acme/shop.git').className).toContain('p-4');
    await expect(container).toHaveNoAxeViolations();
  });

  it('lets flush content run edge to edge', () => {
    render(
      <Card>
        <CardContent flush>
          <ul aria-label="Runs" />
        </CardContent>
      </Card>,
    );

    expect(screen.getByRole('list', { name: 'Runs' }).parentElement?.className).not.toContain(
      'p-4',
    );
  });
});
