import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuns, RunDetail } from '..';
import type { WorkflowSummaryOutput } from '../../../platform/api';
import { aRun, fakeRunsApi, problem, PROJECT } from './fake-runs-api';

/** A valid Workflow as the list answers it. */
const summary = (
  name: string,
  overrides: Partial<WorkflowSummaryOutput> = {},
): WorkflowSummaryOutput => ({
  name,
  description: `Does ${name}`,
  valid: true,
  usable: true,
  notUsableReason: null,
  problems: [],
  ...overrides,
});

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const dialog = () => screen.getByRole('dialog', { name: 'New run' });
const chooser = () => within(dialog()).getByLabelText<HTMLSelectElement>('Agent or Workflow');

async function openDialog() {
  render(
    <QueryClientProvider client={client()}>
      <ProjectRuns projectId={PROJECT.id} repository="ready" />
    </QueryClientProvider>,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'New run' }));
  await vi.waitFor(() => expect(within(dialog()).queryByText('Checking the agents…')).toBeNull());
}

afterEach(() => push.mockReset());

describe('New run: agents and Workflows in one chooser', () => {
  it('groups the agents and the usable Workflows, and leaves out a Workflow that is not usable', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([
      summary('ship'),
      summary('broken', { usable: false, notUsableReason: 'A Provider is off.' }),
    ]);
    await openDialog();

    const groups = within(chooser()).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('label'))).toEqual(['Agents', 'Workflows']);
    expect(
      within(groups[1]!)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['ship']);
    await expect(document.body).toHaveNoAxeViolations();
  });

  it("says why the project's default Workflow is not the one chosen when it cannot start a run", async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([
      summary('slow', {
        usable: false,
        notUsableReason: 'The phase "check" uses Codex, which is off.',
      }),
      summary('ship'),
    ]);
    api.respondNext('project', 200, { ...PROJECT, defaultWorkflow: 'slow' });
    await openDialog();

    expect(within(dialog()).getByTestId('agent-fallback-note').textContent).toContain(
      'The Workflow slow cannot start a run now (The phase "check" uses Codex, which is off.)',
    );
    expect(chooser().value).not.toBe('workflow:slow');
  });

  it('chooses the default Workflow when it can start a run, with no note', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([summary('ship')]);
    api.respondNext('project', 200, { ...PROJECT, defaultWorkflow: 'ship' });
    await openDialog();

    expect(chooser().value).toBe('workflow:ship');
    expect(within(dialog()).queryByTestId('agent-fallback-note')).toBeNull();
  });

  it('offers no Workflows group when there is none', async () => {
    fakeRunsApi([]);
    await openDialog();

    expect(within(chooser()).getAllByRole('group')).toHaveLength(1);
  });

  it('starts with the chosen Workflow, naming it in place of an agent', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([summary('ship', { description: 'Builds and polishes' })]);
    await openDialog();

    await userEvent.selectOptions(chooser(), 'workflow:ship');
    expect(within(dialog()).getByTestId('workflow-facts').textContent).toContain('ship');
    expect(within(dialog()).getByText('Builds and polishes')).toBeTruthy();
    await userEvent.type(within(dialog()).getByLabelText('Task'), 'Add a health check');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start run' }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(api.calls('start')[0]!.body).toEqual({ task: 'Add a health check', workflow: 'ship' });
  });

  it('can be driven by the keyboard alone', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([summary('ship')]);
    await openDialog();

    await userEvent.type(within(dialog()).getByLabelText('Task'), 'Do it');
    await userEvent.tab();
    expect(document.activeElement).toBe(chooser());
    await userEvent.keyboard('{Enter}');
    await userEvent.selectOptions(chooser(), 'workflow:ship');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start run' }));

    await vi.waitFor(() => expect(api.calls('start')).toHaveLength(1));
  });

  it('says what a refused Workflow was refused for, and reads the list again', async () => {
    const api = fakeRunsApi([]);
    api.setWorkflows([summary('ship')]);
    await openDialog();
    api.respondNext('start', 409, {
      ...problem(
        409,
        'Workflow not usable',
        'The Workflow cannot be used: a Phase names a gone agent.',
      ),
      type: 'urn:agentic-studio:problem:workflow-not-usable',
    });

    await userEvent.selectOptions(chooser(), 'workflow:ship');
    await userEvent.type(within(dialog()).getByLabelText('Task'), 'Do it');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Start run' }));

    expect(await within(dialog()).findByText(/This Workflow cannot start a run now/)).toBeTruthy();
    expect(within(dialog()).getByText(/a Phase names a gone agent/)).toBeTruthy();
    await vi.waitFor(() => expect(api.calls('workflows').length).toBeGreaterThan(1));
  });
});

describe('Run page: the Phases of a Workflow Run', () => {
  const phase = (
    position: number,
    state: 'pending' | 'running' | 'done' | 'failed',
    more: { summary?: string; stepsUsed?: number } = {},
  ) => ({
    position,
    itemId: ['build', 'polish'][position]!,
    kind: 'work' as const,
    state,
    verdict: null,
    findings: [],
    summary: null as string | null,
    rounds: [],
    agent: {
      name: ['builder', 'polisher'][position]!,
      source: 'definitions' as const,
      commit: 'c'.repeat(40),
      provider: position === 0 ? ('codex' as const) : ('claude_code' as const),
      model: 'default',
      skills: [] as string[],
    },
    stepsUsed: 0,
    ...more,
  });

  const workflowRun = () =>
    aRun({
      state: 'running',
      workflowName: 'ship',
      workflow: {
        name: 'ship',
        commit: 'c'.repeat(40),
        items: [
          { id: 'build', kind: 'work', agent: 'builder' },
          { id: 'polish', kind: 'work', agent: 'polisher' },
        ],
      },
      phases: [
        phase(0, 'done', { summary: 'Built the endpoint.', stepsUsed: 1 }),
        phase(1, 'running'),
      ],
    });

  const renderRun = (runId: string) =>
    render(
      <QueryClientProvider client={client()}>
        <RunDetail runId={runId} />
      </QueryClientProvider>,
    );

  it('shows each Phase with its agent and result, and marks the one that is running', async () => {
    const run = workflowRun();
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    const items = within(card).getAllByTestId('run-phase');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('builder');
    expect(items[0]!.textContent).toContain('Done');
    expect(within(items[0]!).getByTestId('run-phase-summary').textContent).toBe(
      'Built the endpoint.',
    );
    expect(items[1]!.textContent).toContain('Claude Code');
    expect(items[1]!.getAttribute('aria-current')).toBe('step');
    expect(items[0]!.getAttribute('aria-current')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('shows no Phases for a Run started with an agent', async () => {
    const run = aRun({ state: 'running' });
    fakeRunsApi([run]);
    renderRun(run.id);

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('run-phase')).toBeNull();
  });

  it('opens Run again with the Workflow chosen', async () => {
    const run = { ...workflowRun(), state: 'succeeded' as const };
    const api = fakeRunsApi([run]);
    api.setWorkflows([summary('ship')]);
    renderRun(run.id);

    await userEvent.click(await screen.findByRole('button', { name: 'Run again' }));

    await vi.waitFor(() => expect(chooser().value).toBe('workflow:ship'));
  });
});

describe('Run page: the Verdict and findings of a review Phase', () => {
  const FINDINGS = [
    { text: 'The loop never ends.', file: 'src/loop.ts', line: 12 },
    { text: '<img src=x onerror=alert(1)> and **not bold**, [a link](https://example.test).' },
    { text: 'Absolute path.', file: '/etc/passwd', line: 1 },
    { text: 'Leaves the copy.', file: '../outside/secret.txt' },
    { text: 'Backslash.', file: 'src\\win.ts' },
    { text: 'Drive.', file: 'C:/Users/x.txt' },
  ];

  const reviewRun = (verdict: 'approved' | 'changes_requested', findings = FINDINGS) =>
    aRun({
      state: 'succeeded',
      workflowName: 'ship',
      reviewNotPassed: verdict === 'changes_requested',
      workflow: {
        name: 'ship',
        commit: 'c'.repeat(40),
        items: [
          { id: 'build', kind: 'work', agent: 'builder' },
          { id: 'check', kind: 'review', agent: 'reviewer' },
        ],
      },
      phases: [
        {
          position: 0,
          itemId: 'build',
          kind: 'work',
          state: 'done',
          verdict: null,
          findings: [],
          summary: 'Built the endpoint.',
          rounds: [],
          agent: {
            name: 'builder',
            source: 'definitions',
            commit: 'c'.repeat(40),
            provider: 'codex',
            model: 'default',
            skills: [],
          },
          stepsUsed: 1,
        },
        {
          position: 1,
          itemId: 'check',
          kind: 'review',
          state: 'done',
          verdict,
          findings,
          summary: 'Looked at it.',
          rounds: [],
          agent: {
            name: 'reviewer',
            source: 'definitions',
            commit: 'c'.repeat(40),
            provider: 'claude_code',
            model: 'default',
            skills: [],
          },
          stepsUsed: 1,
        },
      ],
    });

  const renderRun = (runId: string) =>
    render(
      <QueryClientProvider client={client()}>
        <RunDetail runId={runId} />
      </QueryClientProvider>,
    );

  it('shows the Verdict with its word and every finding as plain text', async () => {
    const run = reviewRun('changes_requested');
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    const [work, review] = within(card).getAllByTestId('run-phase');
    expect(work!.textContent).not.toContain('Verdict');
    expect(review!.textContent).toContain('Verdict: Changes requested');
    expect(review!.textContent).toContain('(review)');
    const texts = within(review!)
      .getAllByTestId('run-finding-text')
      .map((element) => element.textContent);
    expect(texts[0]).toBe('The loop never ends.');
    expect(texts[1]).toBe(
      '<img src=x onerror=alert(1)> and **not bold**, [a link](https://example.test).',
    );
    expect(within(card).getByTestId('review-not-passed').textContent).toContain(
      'Review not passed',
    );
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('never turns a finding into markup: no element, link or image comes from its text', async () => {
    const run = reviewRun('changes_requested');
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    const finding = within(card).getAllByTestId('run-finding-text')[1]!;
    expect(finding.querySelector('img, a, strong, b')).toBeNull();
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('a[href="https://example.test"]')).toBeNull();
  });

  it('shows an approval with its word, and no "review not passed"', async () => {
    const run = reviewRun('approved', []);
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    expect(within(card).getAllByTestId('run-phase')[1]!.textContent).toContain('Verdict: Approved');
    expect(within(card).queryByTestId('run-finding')).toBeNull();
    expect(within(card).queryByTestId('review-not-passed')).toBeNull();
  });

  it('leads a file inside the Working copy to the Changes tab, and shows every other path as text', async () => {
    const run = reviewRun('changes_requested');
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    const buttons = within(card).getAllByRole('button', { name: /show it on the Changes tab/ });
    expect(buttons.map((button) => button.textContent)).toEqual([
      'src/loop.ts (show it on the Changes tab)',
    ]);
    const plain = within(card)
      .getAllByTestId('run-finding-file')
      .map((element) => element.textContent);
    expect(plain).toEqual([
      '/etc/passwd',
      '../outside/secret.txt',
      'src\\win.ts',
      'C:/Users/x.txt',
    ]);
    expect(card.querySelectorAll('a')).toHaveLength(0);
  });

  it('opens the Changes tab and selects the file that the finding names', async () => {
    const run = reviewRun('changes_requested');
    const api = fakeRunsApi([run]);
    api.setDiff(run.id, 'run', {
      baseCommit: 'a'.repeat(40),
      includesUnpushed: true,
      truncated: false,
      files: [
        { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
        { path: 'src/loop.ts', status: 'modified', additions: 2, deletions: 1 },
      ],
    });
    renderRun(run.id);

    await userEvent.click(
      await screen.findByRole('button', { name: /src\/loop\.ts\s*\(show it on the Changes tab\)/ }),
    );

    const tab = await screen.findByRole('tab', { name: 'Changes' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const list = await screen.findByRole('navigation', { name: /Changed files/ });
    await vi.waitFor(() =>
      expect(
        within(list)
          .getByRole('button', { name: /src\/loop.ts/ })
          .getAttribute('aria-current'),
      ).toBe('true'),
    );
  });

  it('can be reached and used with the keyboard alone', async () => {
    const run = reviewRun('changes_requested');
    fakeRunsApi([run]);
    renderRun(run.id);

    const button = await screen.findByRole('button', { name: /show it on the Changes tab/ });
    button.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Enter}');

    expect(
      (await screen.findByRole('tab', { name: 'Changes' })).getAttribute('aria-selected'),
    ).toBe('true');
  });
});

describe('Runs list: a Run whose review did not pass', () => {
  it('marks the row with words, and only that row', async () => {
    fakeRunsApi([
      aRun({ task: 'One', workflowName: 'ship', reviewNotPassed: true }),
      aRun({ task: 'Two', workflowName: 'ship' }),
    ]);
    render(
      <QueryClientProvider client={client()}>
        <ProjectRuns projectId={PROJECT.id} repository="ready" />
      </QueryClientProvider>,
    );

    const list = await screen.findByRole('list', { name: 'Runs' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first!).getByTestId('review-not-passed-marker').textContent).toBe(
      'Review not passed',
    );
    expect(within(second!).queryByTestId('review-not-passed-marker')).toBeNull();
    await expect(document.body).toHaveNoAxeViolations();
  });
});

describe('Runs list: the Workflow of a Run', () => {
  it('names the Workflow on a row, and nothing on a Run with an agent', async () => {
    fakeRunsApi([aRun({ task: 'One', workflowName: 'ship' }), aRun({ task: 'Two' })]);
    render(
      <QueryClientProvider client={client()}>
        <ProjectRuns projectId={PROJECT.id} repository="ready" />
      </QueryClientProvider>,
    );

    const list = await screen.findByRole('list', { name: 'Runs' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first!.textContent).toContain('Workflow ship');
    expect(second!.textContent).not.toContain('Workflow');
  });
});

describe('Run page: the rounds of a Run whose review sent work back', () => {
  const FINDINGS = [
    { text: 'The loop never ends.', file: 'src/loop.ts', line: 12 },
    { text: '<img src=x onerror=alert(1)> and **not bold**.' },
    { text: 'Leaves the copy.', file: '../outside/secret.txt' },
  ];
  const agent = (name: string, provider: 'codex' | 'claude_code') => ({
    name,
    source: 'definitions' as const,
    commit: 'c'.repeat(40),
    provider,
    model: 'default',
    skills: [] as string[],
  });
  type Round = {
    round: number;
    summary: string | null;
    verdict: 'approved' | 'changes_requested' | null;
    findings: { text: string; file?: string; line?: number }[];
  };

  /** The Workflow of a work Phase and a review, with what each reported in each round. */
  const roundsRun = (
    work: { summary: string | null; rounds: Round[]; state?: 'done' | 'running' | 'pending' },
    review: {
      summary: string | null;
      verdict: 'approved' | 'changes_requested' | null;
      findings: { text: string; file?: string; line?: number }[];
      rounds: Round[];
      state?: 'done' | 'running' | 'pending';
    },
    sendBacks: { used: number; limit: number } | null = { used: 1, limit: 2 },
  ) =>
    aRun({
      state: 'running',
      workflowName: 'ship',
      sendBacks,
      workflow: {
        name: 'ship',
        commit: 'c'.repeat(40),
        items: [
          { id: 'build', kind: 'work', agent: 'builder' },
          { id: 'check', kind: 'review', agent: 'reviewer' },
        ],
      },
      phases: [
        {
          position: 0,
          itemId: 'build',
          kind: 'work',
          state: work.state ?? 'done',
          verdict: null,
          findings: [],
          summary: work.summary,
          rounds: work.rounds,
          agent: agent('builder', 'codex'),
          stepsUsed: 2,
        },
        {
          position: 1,
          itemId: 'check',
          kind: 'review',
          state: review.state ?? 'done',
          verdict: review.verdict,
          findings: review.findings,
          summary: review.summary,
          rounds: review.rounds,
          agent: agent('reviewer', 'claude_code'),
          stepsUsed: 2,
        },
      ],
    });

  /** One send-back, then approved: both Phases ran twice. */
  const twoRounds = () =>
    roundsRun(
      {
        summary: 'Fixed the loop.',
        rounds: [
          { round: 1, summary: 'Built the endpoint.', verdict: null, findings: [] },
          { round: 2, summary: 'Fixed the loop.', verdict: null, findings: [] },
        ],
      },
      {
        summary: 'Looks right now.',
        verdict: 'approved',
        findings: [],
        rounds: [
          {
            round: 1,
            summary: 'The loop is wrong.',
            verdict: 'changes_requested',
            findings: FINDINGS,
          },
          { round: 2, summary: 'Looks right now.', verdict: 'approved', findings: [] },
        ],
      },
    );

  const renderRun = (runId: string) =>
    render(
      <QueryClientProvider client={client()}>
        <RunDetail runId={runId} />
      </QueryClientProvider>,
    );

  it('says how many send-backs were used out of the limit', async () => {
    const run = twoRounds();
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    expect(within(card).getByTestId('run-send-backs').textContent).toBe('Send-backs used: 1 of 2');
  });

  it('shows each review with its Verdict and findings, and what the work Phase reported after them', async () => {
    const run = twoRounds();
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    const [work, review] = within(card).getAllByTestId('run-phase');
    const workRounds = await within(work!).findAllByTestId('run-phase-round');
    expect(workRounds.map((item) => item.textContent)).toEqual([
      'Round 1Built the endpoint.',
      'Round 2Fixed the loop.',
    ]);
    const reviewRounds = await within(review!).findAllByTestId('run-phase-round');
    expect(reviewRounds).toHaveLength(2);
    expect(reviewRounds[0]!.textContent).toContain('Verdict: Changes requested');
    expect(within(reviewRounds[0]!).getAllByTestId('run-finding')).toHaveLength(3);
    expect(reviewRounds[1]!.textContent).toContain('Verdict: Approved');
    // The latest result is in its round, not shown a second time on top.
    expect(within(work!).queryByTestId('run-phase-summary')).toBeNull();
    expect(within(review!).queryByTestId('run-phase-summary')).toBeNull();
  });

  it('shows a finding as plain text, never as markup', async () => {
    const run = twoRounds();
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    await within(card).findAllByTestId('run-phase-round');
    const texts = within(card)
      .getAllByTestId('run-finding-text')
      .map((element) => element.textContent);
    expect(texts[1]).toBe('<img src=x onerror=alert(1)> and **not bold**.');
    expect(card.querySelector('img, a, strong, b')).toBeNull();
    expect(
      within(card)
        .getAllByTestId('run-finding-file')
        .map((element) => element.textContent),
    ).toEqual(['../outside/secret.txt']);
  });

  it('shows the findings that went back while the work Phase is working on the next round', async () => {
    const run = roundsRun(
      {
        summary: null,
        state: 'running',
        rounds: [{ round: 1, summary: 'Built the endpoint.', verdict: null, findings: [] }],
      },
      {
        summary: null,
        verdict: null,
        findings: [],
        state: 'pending',
        rounds: [
          {
            round: 1,
            summary: 'The loop is wrong.',
            verdict: 'changes_requested',
            findings: FINDINGS,
          },
        ],
      },
    );
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    const [work, review] = within(card).getAllByTestId('run-phase');
    const workRounds = await within(work!).findAllByTestId('run-phase-round');
    expect(workRounds.map((item) => item.textContent)).toEqual([
      'Round 1Built the endpoint.',
      'Round 2Working now',
    ]);
    const reviewRounds = await within(review!).findAllByTestId('run-phase-round');
    expect(reviewRounds[0]!.textContent).toContain('Changes requested');
    expect(within(reviewRounds[0]!).getAllByTestId('run-finding')).toHaveLength(3);
    expect(reviewRounds[1]!.textContent).toBe('Round 2Waiting for its turn');
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('shows a Phase that ran once as it always did, with no rounds, and the count of none used', async () => {
    const run = roundsRun(
      {
        summary: 'Built the endpoint.',
        rounds: [{ round: 1, summary: 'Built the endpoint.', verdict: null, findings: [] }],
      },
      {
        summary: 'Fine.',
        verdict: 'approved',
        findings: [],
        rounds: [{ round: 1, summary: 'Fine.', verdict: 'approved', findings: [] }],
      },
      { used: 0, limit: 2 },
    );
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    expect(within(card).getByTestId('run-send-backs').textContent).toBe('Send-backs used: 0 of 2');
    expect(within(card).queryByTestId('run-phase-round')).toBeNull();
    expect(within(card).getAllByTestId('run-phase-summary')).toHaveLength(2);
  });

  it('shows "review not passed" after the last round with the limit used', async () => {
    const run = {
      ...roundsRun(
        {
          summary: 'Tried again.',
          rounds: [
            { round: 1, summary: 'Built.', verdict: null, findings: [] },
            { round: 2, summary: 'Tried again.', verdict: null, findings: [] },
            { round: 3, summary: 'Tried once more.', verdict: null, findings: [] },
          ],
        },
        {
          summary: 'Still wrong.',
          verdict: 'changes_requested',
          findings: [{ text: 'Still open.' }],
          rounds: [
            { round: 1, summary: 'Wrong.', verdict: 'changes_requested', findings: FINDINGS },
            { round: 2, summary: 'Wrong.', verdict: 'changes_requested', findings: FINDINGS },
            {
              round: 3,
              summary: 'Still wrong.',
              verdict: 'changes_requested',
              findings: [{ text: 'Still open.' }],
            },
          ],
        },
        { used: 2, limit: 2 },
      ),
      state: 'succeeded' as const,
      reviewNotPassed: true,
    };
    fakeRunsApi([run]);
    renderRun(run.id);

    const card = await screen.findByRole('region', { name: 'Phases of ship' });
    expect(within(card).getByTestId('run-send-backs').textContent).toBe('Send-backs used: 2 of 2');
    const [, review] = within(card).getAllByTestId('run-phase');
    expect(await within(review!).findAllByTestId('run-phase-round')).toHaveLength(3);
    expect(within(card).getByTestId('review-not-passed')).toBeTruthy();
  });

  it('leaves the rounds out of a Run started with an agent, and has no send-back line for it', async () => {
    const run = aRun({ state: 'running' });
    fakeRunsApi([run]);
    renderRun(run.id);

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('run-send-backs')).toBeNull();
    expect(screen.queryByTestId('run-phase-round')).toBeNull();
  });

  it('can be reached with the keyboard alone: a finding in a round leads to the Changes tab', async () => {
    const run = twoRounds();
    const api = fakeRunsApi([run]);
    api.setDiff(run.id, 'run', {
      baseCommit: 'a'.repeat(40),
      includesUnpushed: true,
      truncated: false,
      files: [{ path: 'src/loop.ts', status: 'modified', additions: 2, deletions: 1 }],
    });
    renderRun(run.id);

    const button = await screen.findByRole('button', { name: /show it on the Changes tab/ });
    button.focus();
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Enter}');

    expect(
      (await screen.findByRole('tab', { name: 'Changes' })).getAttribute('aria-selected'),
    ).toBe('true');
  });
});
