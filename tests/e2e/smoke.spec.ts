import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

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
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);

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
  // The open menu (and its popover layout) is scanned in the browser too.
  await expectNoAxeViolations(page);
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
    await expectNoAxeViolations(page);
    // Focus stays in the sheet when tabbing past its last control.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await sheet.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    // A visible close control (44px on touch) for users without an Esc key.
    await topBar.getByRole('button', { name: 'Open navigation' }).tap();
    const close = sheet.getByRole('button', { name: 'Close navigation' });
    const closeBox = await close.boundingBox();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);
    await close.tap();
    await expect(sheet).toHaveCount(0);
  } else {
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Projects' }),
    ).toHaveAttribute('aria-current', 'page');
  }

  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);

  // New project opens the dialog: centred on desktop, a bottom sheet on phones (#44).
  await main.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  const nameField = dialog.getByLabel('Project name');
  await expect(nameField).toBeFocused();
  const viewport = page.viewportSize()!;
  // Polled: the box settles once the 150ms open animation ends.
  const dialogEdges = async () => {
    const box = await dialog.boundingBox();
    return box && { width: box.width, bottom: Math.round(box.y + box.height) };
  };
  if (phone) {
    await expect.poll(dialogEdges).toEqual({ width: viewport.width, bottom: viewport.height });
  } else {
    await expect.poll(async () => (await dialogEdges())?.width).toBeLessThan(viewport.width / 2);
  }
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);

  await nameField.fill(`  ${projectName.replace(/ /g, '   ')}  `);
  await dialog.getByRole('button', { name: 'Create project' }).click();

  // The dialog closes, a toast confirms, and the list shows the project without a manual
  // reload, with the name as the API normalized it.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Project created')).toBeVisible();
  // Scanned once the toast has faded in: mid-animation its text is part-transparent.
  const toast = page.locator('[data-sonner-toast]');
  await expect(toast).toHaveCSS('opacity', '1');
  const projects = main.getByRole('list', { name: 'Projects' });
  await expect(projects.getByRole('heading', { name: projectName })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);
  // The toast was still on screen, so the scan included it.
  await expect(toast).toBeVisible();

  await page.reload();
  await expect(projects.getByRole('heading', { name: projectName })).toBeVisible();
  // Exactly one: not created twice. Counted by this run's unique name, since both Playwright
  // projects share the database.
  await expect(projects.getByRole('listitem').filter({ hasText: projectName })).toHaveCount(1);

  // Logout ends the session: Projects sends the browser back to the login page.
  await topBar.getByRole('button', { name: 'Operator menu' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
});

// The first paint, before any script runs: the server-rendered sidebar and the spacer that
// offsets the page already have their final width (240px column or 64px rail), so neither the
// sidebar nor the page content shifts on hydration (#43).
test('the server-rendered sidebar has its final width before scripts run', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'checks desktop and tablet widths');
  const cases = [
    { width: 1440, cookie: undefined, expected: 240 },
    { width: 1024, cookie: undefined, expected: 64 },
    { width: 1024, cookie: 'true', expected: 240 },
    { width: 1440, cookie: 'false', expected: 64 },
  ];
  for (const { width, cookie, expected } of cases) {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width, height: 900 },
    });
    if (cookie !== undefined) {
      await context.addCookies([{ name: 'sidebar_state', value: cookie, url: baseURL! }]);
    }
    const page = await context.newPage();
    await page.goto('/projects');
    const label = `width ${width}, sidebar_state=${cookie ?? '(none)'}`;
    const container = await page.locator('[data-slot="sidebar-container"]').boundingBox();
    const gap = await page.locator('[data-slot="sidebar-gap"]').boundingBox();
    const main = await page.getByRole('main', { name: 'Page content' }).boundingBox();
    expect(container?.width, label).toBe(expected);
    expect(gap?.width, label).toBe(expected);
    expect(main?.x, label).toBe(expected);
    await context.close();
  }
});

// A login request that gets no HTTP response says the API is unreachable (#52). The request
// is aborted in the browser, so the API and the session store are untouched.
test('login says the API is unreachable when the request gets no response', async ({ page }) => {
  await page.route('**/api/auth/login', (route) => route.abort('connectionrefused'));
  await page.goto('/login');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Filtered: Next.js's route announcer is an alert too.
  const alert = page.getByRole('alert').filter({ hasText: 'unreachable' });
  await expect(alert).toHaveText('The Studio API is unreachable.');
  await expect(page).toHaveURL(/\/login$/);
});

/**
 * Scans the page (no sideways scroll, axe) in the dark theme and again in the light one
 * (stored the way next-themes stores it, then reloaded), and leaves the dark theme set.
 */
async function expectInBothThemes(page: Page, ready: Locator) {
  for (const theme of ['light', 'dark']) {
    await expectNoHorizontalScroll(page);
    await expectNoAxeViolations(page);
    await page.evaluate((value) => localStorage.setItem('theme', value), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(new RegExp(`(^|\\s)${theme}(\\s|$)`));
    await expect(ready).toBeVisible();
  }
}

/** Signs in through the login page and lands on Projects. */
async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill(operatorPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/projects$/);
}

/** Creates a project through the New project dialog and opens it from the list. */
async function createAndOpenProject(page: Page, name: string) {
  const main = page.getByRole('main', { name: 'Page content' });
  await main.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByLabel('Project name').fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog).toHaveCount(0);
  await main.getByRole('list', { name: 'Projects' }).getByRole('link', { name }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(main.getByRole('heading', { level: 1, name })).toBeVisible();
  return main;
}

// Story #60: create a project, open it, connect a fixture Repository over the test-only file
// transport, see it ready with a commit id, and keep it across a reload. Linux only, like every
// repository feature; `pnpm e2e:smoke` fails on Linux if this test did not run and pass.
test('operator connects a repository and sees it ready', async ({ page }, testInfo) => {
  test.skip(
    process.env.E2E_API_PLATFORM !== 'linux',
    'Repository features run on Linux only; CI runs this test on Linux.',
  );
  const base = process.env.E2E_FIXTURE_REPO_BASE;
  if (!base) throw new Error('E2E_FIXTURE_REPO_BASE is not set; run `pnpm e2e:smoke` on Linux');
  const phone = testInfo.project.name === 'phone';
  const projectName = `Repository ${testInfo.project.name}`;
  const url = `${base}${testInfo.project.name}.git`;

  await signIn(page);
  const main = await createAndOpenProject(page, projectName);

  // Breadcrumb: Projects › name.
  const breadcrumb = page
    .getByRole('banner', { name: 'Top bar' })
    .getByRole('navigation', { name: 'Breadcrumb' });
  await expect(breadcrumb.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(breadcrumb.getByText(projectName)).toHaveAttribute('aria-current', 'page');

  // No repository yet: the card is an empty state with the Connect action.
  const card = main.getByRole('region', { name: 'Repository' });
  await expect(card.getByRole('heading', { name: 'No repository connected' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page);

  await card.getByRole('button', { name: 'Connect repository' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect repository' });
  await expect(dialog.getByLabel('Integration branch')).toHaveValue('dev');
  if (phone) {
    const viewport = page.viewportSize()!;
    await expect
      .poll(async () => {
        const box = await dialog.boundingBox();
        return box && { width: box.width, bottom: Math.round(box.y + box.height) };
      })
      .toEqual({ width: viewport.width, bottom: viewport.height });
  }
  await expectNoAxeViolations(page);

  // First a branch the fixture does not have: the clone fails with branch_not_found.
  await dialog.getByLabel('Repository URL').fill(url);
  await dialog.getByLabel('Integration branch').fill('release');
  await dialog.getByRole('button', { name: 'Connect repository' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByText('Failed')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('alert')).toContainText('Its default branch is "main"');
  await expectInBothThemes(page, card.getByText('Failed'));

  // Change settings reopens Connect prefilled; the integration branch is fixed there.
  await card.getByRole('button', { name: 'Change settings' }).click();
  await expect(dialog.getByLabel('Repository URL')).toHaveValue(url);
  await dialog.getByLabel('Integration branch').fill('dev');
  await dialog.getByRole('button', { name: 'Connect repository' }).click();
  await expect(dialog).toHaveCount(0);

  // The clone runs in the background; the card polls until the Repository is ready.
  await expect(card.getByText('Connected')).toBeVisible({ timeout: 30_000 });
  const commit = card.locator('code').filter({ hasText: /^[0-9a-f]{7}$/ });
  await expect(commit).toBeVisible();
  await expect(card.getByText(url)).toBeVisible();
  await expect(card.getByText('Last fetched')).toBeVisible();
  await expectInBothThemes(page, card.getByText('Connected'));

  // State comes from the server: a reload shows the same Repository.
  const commitId = await commit.textContent();
  await page.reload();
  await expect(card.getByText('Connected')).toBeVisible();
  await expect(card.locator('code').filter({ hasText: commitId! })).toBeVisible();

  await breadcrumb.getByRole('link', { name: 'Projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

// On an API host that is not Linux (a native Windows or macOS development machine), connect
// answers 501 "Unsupported platform" and the dialog shows it; CI (Linux) skips this.
test('connect says the platform is unsupported on an API host that is not Linux', async ({
  page,
}, testInfo) => {
  test.skip(process.env.E2E_API_PLATFORM === 'linux', 'The API host is Linux.');
  await signIn(page);
  const main = await createAndOpenProject(page, `Unsupported ${testInfo.project.name}`);

  await main.getByRole('button', { name: 'Connect repository' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect repository' });
  await dialog.getByLabel('Repository URL').fill('https://github.com/acme/shop.git');
  await dialog.getByRole('button', { name: 'Connect repository' }).click();

  await expect(dialog.getByRole('alert')).toContainText('Unsupported platform');
  await expectNoAxeViolations(page);
});
