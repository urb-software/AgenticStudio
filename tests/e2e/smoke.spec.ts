import { expect, test } from '@playwright/test';

// Story #16 walking-skeleton smoke: Next.js → typed REST → NestJS → PostgreSQL, with the
// Redis session, through the browser. The database starts empty for every run.

function operatorPassword(): string {
  const password = process.env.E2E_OPERATOR_PASSWORD;
  if (!password) {
    throw new Error('E2E_OPERATOR_PASSWORD is not set; run the smoke test with `pnpm e2e:smoke`');
  }
  return password;
}

test('operator logs in, creates a project, sees it listed, and it survives a reload', async ({
  page,
}) => {
  // Without a session, the Projects page sends the browser to the login page.
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Password').fill(operatorPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in as the operator.')).toBeVisible();

  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByText('No projects yet.')).toBeVisible();

  await page.getByLabel('Project name').fill('  Walking   Skeleton  ');
  await page.getByRole('button', { name: 'Create project' }).click();

  const projects = page.getByRole('list', { name: 'Projects' });
  // Shown without a manual reload, with the name as the API normalized it.
  await expect(projects.getByRole('heading', { name: 'Walking Skeleton' })).toBeVisible();
  await expect(page.getByLabel('Project name')).toHaveValue('');

  await page.reload();
  await expect(projects.getByRole('heading', { name: 'Walking Skeleton' })).toBeVisible();
  await expect(projects.getByRole('listitem')).toHaveCount(1);
});
