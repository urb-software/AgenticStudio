import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// Story #16 walking-skeleton smoke: Next.js → typed REST → NestJS → PostgreSQL, with the
// Redis session, through the browser, inside the Studio Shell (#43). It runs once per
// Playwright project (desktop 1440×900, phone 390×844); the database starts empty for every
// `pnpm e2e:smoke` run and is shared by both projects, so each creates its own project.

function operatorPassword(): string {
  const password = process.env.E2E_OPERATOR_PASSWORD;
  if (!password) {
    throw new Error('E2E_OPERATOR_PASSWORD is not set; run the smoke test with `pnpm e2e:smoke`');
  }
  return password;
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/** Whole-page axe scan; any violation fails (no rule is disabled). */
async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target).join(', ')})`),
  ).toEqual([]);
}

test('operator logs in, uses the shell, creates a project, and logs out', async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === 'phone';
  const projectName = `Walking Skeleton ${testInfo.project.name}`;
  const topBar = page.getByRole('banner', { name: 'Top bar' });

  // Without a session, the Projects page sends the browser to the login page, which has no shell.
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(topBar).toHaveCount(0);

  await page.getByLabel('Password').fill(operatorPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();

  // `/` redirects to Projects.
  await expect(page).toHaveURL(/\/projects$/);
  const main = page.getByRole('main', { name: 'Page content' });
  await expect(main.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(
    topBar.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Projects'),
  ).toHaveAttribute('aria-current', 'page');

  // The operator menu shows the signed-in operator (and the theme toggle on phones).
  await topBar.getByRole('button', { name: 'Operator menu' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Operator', { exact: true })).toBeVisible();
  await expect(menu.getByText('Signed in')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
  const menuTheme = menu.getByRole('menuitem', { name: 'Switch to light theme' });
  const topBarTheme = topBar.getByRole('button', { name: 'Switch to light theme' });
  if (phone) {
    await expect(menuTheme).toBeVisible();
    await expect(topBarTheme).toBeHidden();
  } else {
    await expect(menuTheme).toBeHidden();
    await expect(topBarTheme).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Navigation: the sidebar on desktop, an off-canvas sheet on phones.
  if (phone) {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
    await topBar.getByRole('button', { name: 'Open navigation' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Navigation' });
    await expect(sheet.getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  } else {
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Projects' }),
    ).toHaveAttribute('aria-current', 'page');
  }

  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);

  await main.getByLabel('Project name').fill(`  ${projectName.replace(/ /g, '   ')}  `);
  await main.getByRole('button', { name: 'Create project' }).click();

  const projects = main.getByRole('list', { name: 'Projects' });
  // Shown without a manual reload, with the name as the API normalized it.
  await expect(projects.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(main.getByLabel('Project name')).toHaveValue('');
  await expectNoHorizontalScroll(page);

  await page.reload();
  await expect(projects.getByRole('heading', { name: projectName })).toBeVisible();

  // Logout ends the session: Projects sends the browser back to the login page.
  await topBar.getByRole('button', { name: 'Operator menu' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
});
