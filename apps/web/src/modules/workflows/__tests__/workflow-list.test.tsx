import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowSummaryOutput } from '../../../platform/api';
import { WorkflowList } from '../features/workflow-list/workflow-list';
import {
  fakeWorkflowsApi,
  summary,
  WORKFLOWS_COMMIT,
  workflowDetail,
  workflowList,
} from './fake-workflows-api';

const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

const SHIP = summary('ship', { description: 'Build, then review' });
const BROKEN: WorkflowSummaryOutput = summary('broken', {
  description: null,
  valid: false,
  usable: false,
  problems: [
    {
      code: 'checkpoint_first',
      path: 'WORKFLOW.md',
      key: 'sequence',
      message: 'A checkpoint cannot come first.',
    },
    { code: 'workflow_extra_file', path: 'notes.txt', key: null, message: 'Only the entry file.' },
    { code: 'entry_unreadable', path: '', key: null, message: 'The folder cannot be read.' },
  ],
});
const PROVIDER_OFF = summary('slow', {
  usable: false,
  notUsableReason:
    'The phase "check" uses Codex, which is not available: Switched off on the agent worker.',
});

function renderWorkflows() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowList />
    </QueryClientProvider>,
  );
}

const card = () => screen.getByRole('region', { name: 'Workflows' });

beforeEach(() => {
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  search.value = '';
  act(() => focusManager.setFocused(undefined));
  vi.unstubAllGlobals();
});

describe('Workflows page: the list', () => {
  it('lists Workflows with their state, description and the commit, without axe violations', async () => {
    fakeWorkflowsApi(workflowList({ workflows: [BROKEN, PROVIDER_OFF, SHIP] }));
    const { container } = renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    expect(within(card()).getByText('Read at commit')).toBeTruthy();
    expect(within(card()).getByText(WORKFLOWS_COMMIT.slice(0, 7))).toBeTruthy();
    const ship = within(card()).getByText('ship').closest('li')!;
    expect(within(ship).getByText('Usable')).toBeTruthy();
    expect(within(ship).getByText('Build, then review')).toBeTruthy();
    const broken = within(card()).getByText('broken').closest('li')!;
    expect(within(broken).getByText('Not valid')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows each reason of an invalid Workflow with its place', async () => {
    fakeWorkflowsApi(workflowList({ workflows: [BROKEN] }));
    const { container } = renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    const row = within(card()).getByText('broken').closest('li')!;
    expect(within(row).getByText('WORKFLOW.md')).toBeTruthy();
    expect(within(row).getByText('sequence')).toBeTruthy();
    expect(within(row).getByText('notes.txt')).toBeTruthy();
    expect(within(row).getByText(/the Workflow's folder/)).toBeTruthy();
    expect(within(row).getByText(/A checkpoint cannot come first/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says a valid Workflow of a Provider that is not available is not usable, and why', async () => {
    fakeWorkflowsApi(workflowList({ workflows: [PROVIDER_OFF] }));
    const { container } = renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    const row = within(card()).getByText('slow').closest('li')!;
    expect(within(row).getByText('Not usable')).toBeTruthy();
    expect(within(row).queryByText('Not valid')).toBeNull();
    expect(within(row).getByText(/The phase "check" uses Codex/)).toBeTruthy();
    expect(within(row).getByText(/Switched off on the agent worker/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('links a Workflow with an entry file to the editor on its WORKFLOW.md', async () => {
    const noEntry = summary('empty', {
      description: null,
      valid: false,
      usable: false,
      problems: [{ code: 'entry_missing', path: 'WORKFLOW.md', key: null, message: 'No entry.' }],
    });
    fakeWorkflowsApi(workflowList({ workflows: [SHIP, noEntry] }));
    const { container } = renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    const links = within(card()).getAllByRole('link', { name: /^Open in editor/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/agents/editor?path=workflows%2Fship%2FWORKFLOW.md',
    ]);
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows a name that needs escaping as text, with no detail or editor link', async () => {
    const odd = summary('<b>a b</b>', {
      description: null,
      valid: false,
      usable: false,
      problems: [{ code: 'name_invalid', path: '', key: null, message: 'The name is invalid.' }],
    });
    fakeWorkflowsApi(workflowList({ workflows: [odd] }));
    const { container } = renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    expect(within(card()).getByText('<b>a b</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(within(card()).queryByRole('button')).toBeNull();
    expect(within(card()).queryByRole('link', { name: /Open in editor/ })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says more Workflow folders exist when the list is cut', async () => {
    fakeWorkflowsApi(workflowList({ workflows: [SHIP], truncated: true }));
    const { container } = renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    expect(
      within(card()).getByText('More Workflow folders exist than are listed here.'),
    ).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says what to do with no definitions Repository connected', async () => {
    fakeWorkflowsApi(workflowList({ commit: null, repository: null }));
    const { container } = renderWorkflows();

    expect(await screen.findByText('No definitions Repository connected')).toBeTruthy();
    expect(screen.getByText(/Connect it on the Agents page/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect on Agents' }).getAttribute('href')).toBe(
      '/agents',
    );
    await expect(container).toHaveNoAxeViolations();
  });

  it('says what to do before anything was fetched', async () => {
    fakeWorkflowsApi(workflowList({ commit: null }));
    const { container } = renderWorkflows();

    expect(await screen.findByText(/Nothing has been fetched/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says what a Workflow folder looks like when the Repository holds none, and links the editor', async () => {
    fakeWorkflowsApi(workflowList());
    const { container } = renderWorkflows();

    expect(await screen.findByText('No Workflows in the definitions Repository')).toBeTruthy();
    expect(screen.getByText(/workflows\/<name>\/ with a WORKFLOW.md file/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the editor' }).getAttribute('href')).toBe(
      '/agents/editor',
    );
    expect(screen.getByRole('link', { name: 'Go to Agents' }).getAttribute('href')).toBe('/agents');
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the note of a Repository that is not ready above the last known Workflows', async () => {
    fakeWorkflowsApi(
      workflowList({
        repository: { state: 'fetching', note: 'A fetch of the Repository is running.' },
        workflows: [SHIP],
      }),
    );
    const { container } = renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    expect(within(card()).getByText('A fetch of the Repository is running.')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('says the Workflows cannot be loaded, and Retry reads them again', async () => {
    const api = fakeWorkflowsApi(workflowList({ workflows: [SHIP] }));
    api.failNextList(500, {
      type: 'about:blank',
      title: 'Boom',
      status: 500,
      detail: 'x',
      correlationId: 'c',
    });
    const { container } = renderWorkflows();

    expect(await screen.findByText("Couldn't load the Workflows")).toBeTruthy();
    expect(screen.getByText('GET /api/workflows · 500 Boom')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('region', { name: 'Workflows' })).toBeTruthy();
  });

  it('is reachable by keyboard: Tab reaches the link, then Show, and Enter opens the detail', async () => {
    fakeWorkflowsApi(workflowList({ workflows: [SHIP] }), {
      ship: workflowDetail(SHIP, { items: [] }),
    });
    renderWorkflows();

    await screen.findByRole('region', { name: 'Workflows' });
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: /^Open in editor/ }));
    await userEvent.tab();
    const show = screen.getByRole('button', { name: 'Show ship' });
    expect(document.activeElement).toBe(show);
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(show.getAttribute('aria-expanded')).toBe('true'));
  });

  it('reads the list again on window focus and shows a new commit', async () => {
    const api = fakeWorkflowsApi(workflowList({ workflows: [SHIP] }));
    renderWorkflows();
    await screen.findByRole('region', { name: 'Workflows' });
    const next = 'fedcba9876543210fedcba9876543210fedcba98';
    api.serve(workflowList({ commit: next, workflows: [SHIP, summary('added')] }));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    expect(await screen.findByText('added')).toBeTruthy();
    expect(within(card()).getByText(next.slice(0, 7))).toBeTruthy();
    expect(api.count('/api/workflows')).toBe(2);
  });

  it('opens the Workflow named in the address, and brings its row into view once', async () => {
    search.value = 'open=ship';
    fakeWorkflowsApi(workflowList({ workflows: [summary('other'), SHIP] }), {
      ship: workflowDetail(SHIP, { items: [] }),
    });
    renderWorkflows();

    expect(await screen.findByRole('button', { name: 'Hide ship' })).toBeTruthy();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Show other' })).toBeTruthy();
  });
});
