import { WORKFLOW_MAX_ITEMS } from '@agentic-studio/agent-definitions';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDetail } from '../features/workflow-detail/workflow-detail';
import { WorkflowDiagram } from '../features/workflow-diagram/workflow-diagram';
import {
  checkpoint,
  fakeWorkflowsApi,
  review,
  summary,
  WORKFLOWS_COMMIT,
  work,
  workflowDetail,
  workflowList,
} from './fake-workflows-api';

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  vi.unstubAllGlobals();
});

const items = () => [
  work('build', 'builder'),
  checkpoint('ask', 'Look at it\nbefore going on'),
  review('check', 'reviewer'),
];

const order = () => screen.getByRole('list', { name: 'Phases and checkpoints in order' });

describe('WorkflowDiagram', () => {
  it('lists the phases and checkpoints in order, each phase with its kind and agent', async () => {
    const { container } = render(<WorkflowDiagram items={items()} sendBacks={2} />);

    const entries = within(order()).getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(within(entries[0]!).getByText('build')).toBeTruthy();
    expect(within(entries[0]!).getByText('Work')).toBeTruthy();
    expect(within(entries[0]!).getByRole('link', { name: 'builder' })).toBeTruthy();
    expect(within(entries[0]!).getByText(/Claude Code/)).toBeTruthy();
    expect(within(entries[2]!).getByText('Review')).toBeTruthy();
    expect(within(entries[2]!).getByRole('link', { name: 'reviewer' })).toBeTruthy();
    expect(within(entries[2]!).getByText(/Codex/)).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('sends each agent to that agent, escaping the name in the address', () => {
    render(
      <WorkflowDiagram
        items={[work('build', 'builder'), review('check', 'reviewer')]}
        sendBacks={2}
      />,
    );

    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/agents?open=builder',
      '/agents?open=reviewer',
    ]);
  });

  it('draws a checkpoint apart, with its text kept as text', async () => {
    const { container } = render(<WorkflowDiagram items={items()} sendBacks={2} />);

    const entry = within(order()).getAllByRole('listitem')[1]!;
    expect(within(entry).getByText('Checkpoint')).toBeTruthy();
    expect(within(entry).getByText(/The Run waits here/)).toBeTruthy();
    expect(entry.querySelector('[data-kind="checkpoint"]')).not.toBeNull();
    expect(
      Array.from(entry.querySelectorAll('p')).some(
        (p) => p.textContent === 'Look at it\nbefore going on',
      ),
    ).toBe(true);
    await expect(container).toHaveNoAxeViolations();
  });

  it('keeps markup in a checkpoint or an id as visible characters', () => {
    const { container } = render(
      <WorkflowDiagram
        items={[work('build', 'builder'), checkpoint('<i>x</i>', '<script>alert(1)</script>')]}
        sendBacks={2}
      />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
  });

  it('says in words where changes requested go back, and how many times', () => {
    render(<WorkflowDiagram items={items()} sendBacks={2} />);

    const entry = within(order()).getAllByRole('listitem')[2]!;
    expect(
      within(entry).getByText('Changes requested go back to build, at most 2 times.'),
    ).toBeTruthy();
  });

  it('draws one send-back line per review that passes the cards between it and its work phase', () => {
    const { container } = render(<WorkflowDiagram items={items()} sendBacks={2} />);

    const entries = within(order()).getAllByRole('listitem');
    const lines = entries.map(
      (entry) => entry.querySelectorAll('[data-slot="send-back-line"]').length,
    );
    expect(lines).toEqual([1, 1, 1]);
    expect(
      container.querySelectorAll('[data-slot="send-back-line"][aria-hidden="true"]'),
    ).toHaveLength(3);
  });

  it('draws no send-back line and no sentence for a Workflow with no review', () => {
    const { container } = render(
      <WorkflowDiagram items={[work('build', 'builder')]} sendBacks={2} />,
    );

    expect(container.querySelector('[data-slot="send-back-line"]')).toBeNull();
    expect(screen.queryByText(/Changes requested/)).toBeNull();
  });

  it('says nothing is sent back for a limit of zero', () => {
    render(<WorkflowDiagram items={items()} sendBacks={0} />);

    expect(screen.getByText(/this Workflow allows no send-back/)).toBeTruthy();
  });

  it('marks a phase whose agent is missing, invalid or of a Provider that is off', async () => {
    const { container } = render(
      <WorkflowDiagram
        items={[
          work('a', 'gone', { agentState: 'missing', provider: null, usable: false }),
          work('b', 'bad', { agentState: 'invalid', provider: null, usable: false }),
          review('c', 'reviewer', { usable: false }),
        ]}
        sendBacks={1}
      />,
    );

    expect(screen.getByText('This agent does not exist.')).toBeTruthy();
    expect(screen.getByText('This agent is not valid.')).toBeTruthy();
    expect(screen.getByText('The Provider of this agent is not available now.')).toBeTruthy();
    expect(screen.getAllByText('Not usable')).toHaveLength(3);
    // A missing agent leads nowhere.
    expect(screen.queryByRole('link', { name: 'gone' })).toBeNull();
    expect(screen.getByRole('link', { name: 'bad' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('is reachable by keyboard: Tab visits the agent links in order', async () => {
    render(<WorkflowDiagram items={items()} sendBacks={2} />);

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'builder' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'reviewer' }));
  });

  it('shows a Workflow of the largest allowed size as one ordered list', async () => {
    const many = Array.from({ length: WORKFLOW_MAX_ITEMS }, (_, index) =>
      index % 2 === 0 ? work(`p${index}`, 'builder') : review(`p${index}`, 'reviewer'),
    );
    const { container } = render(<WorkflowDiagram items={many} sendBacks={2} />);

    expect(within(order()).getAllByRole('listitem')).toHaveLength(WORKFLOW_MAX_ITEMS);
    await expect(container).toHaveNoAxeViolations();
  });
});

function renderDetail(name = 'ship') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowDetail name={name} commit={WORKFLOWS_COMMIT} />
    </QueryClientProvider>,
  );
}

describe('WorkflowDetail', () => {
  const SHIP = summary('ship');

  it('shows the diagram of the Workflow', async () => {
    fakeWorkflowsApi(workflowList({ workflows: [SHIP] }), {
      ship: workflowDetail(SHIP, { items: items() }),
    });
    const { container } = renderDetail();

    expect(await screen.findByRole('region', { name: 'Phases of this Workflow' })).toBeTruthy();
    expect(within(order()).getAllByRole('listitem')).toHaveLength(3);
    await expect(container).toHaveNoAxeViolations();
  });

  it('says why a valid Workflow cannot be used now', async () => {
    const off = summary('ship', {
      usable: false,
      notUsableReason: 'The phase "check" uses Codex, which is not available.',
    });
    fakeWorkflowsApi(workflowList({ workflows: [off] }), {
      ship: workflowDetail(off, { items: items() }),
    });
    const { container } = renderDetail();

    expect(await screen.findByText(/The phase "check" uses Codex/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Phases of this Workflow' })).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the problems of an invalid Workflow and no phases', async () => {
    const broken = summary('ship', {
      description: null,
      valid: false,
      usable: false,
      problems: [{ code: 'no_phase', path: 'WORKFLOW.md', key: 'sequence', message: 'No phase.' }],
    });
    fakeWorkflowsApi(workflowList({ workflows: [broken] }), {
      ship: workflowDetail(broken, { items: [], sendBacks: null }),
    });
    const { container } = renderDetail();

    expect(await screen.findByText(/cannot be used until its problems are fixed/)).toBeTruthy();
    expect(screen.getByText(/Its phases are not shown/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Phases and checkpoints in order' })).toBeNull();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows the diagram and the problems of a Workflow that names a missing agent', async () => {
    const missing = summary('ship', {
      valid: false,
      usable: false,
      problems: [
        { code: 'phase_agent_missing', path: 'WORKFLOW.md', key: 'gone', message: 'No agent.' },
      ],
    });
    fakeWorkflowsApi(workflowList({ workflows: [missing] }), {
      ship: workflowDetail(missing, {
        items: [work('build', 'gone', { agentState: 'missing', provider: null, usable: false })],
      }),
    });
    renderDetail();

    expect(await screen.findByText('No agent.', { exact: false })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Phases and checkpoints in order' })).toBeTruthy();
    expect(screen.queryByText(/Its phases are not shown/)).toBeNull();
  });

  it('says a Workflow is no longer in the Repository for a 404', async () => {
    fakeWorkflowsApi(workflowList({ workflows: [SHIP] }), {});
    const { container } = renderDetail();

    expect(await screen.findByText('This Workflow is no longer in the Repository')).toBeTruthy();
    expect(screen.getByText('GET /api/workflows/ship')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });
});
