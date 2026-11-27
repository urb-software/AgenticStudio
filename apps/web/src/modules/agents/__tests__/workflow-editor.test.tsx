import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEditor } from '..';
import type {
  AgentDetailOutput,
  AgentDraftOutput,
  AgentFileEntryOutput,
  AgentFileOutput,
  AgentSummaryOutput,
  WorkflowSummaryOutput,
} from '../../../platform/api';
import { agentDetail, agentList, BUILT_INS, fakeAgentsApi } from './fake-agents-api';

vi.mock('../features/agent-editor/monaco-view', () => ({
  default: (props: {
    value: string;
    path: string;
    readOnly?: boolean;
    onChange?: (text: string) => void;
    markers?: { line: number; message: string }[];
  }) =>
    props.readOnly === false ? (
      <textarea
        data-testid="monaco"
        data-path={props.path}
        data-markers={JSON.stringify(props.markers ?? [])}
        aria-label={`File ${props.path}`}
        value={props.value}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    ) : (
      <pre
        data-testid="monaco"
        data-path={props.path}
        data-markers={JSON.stringify(props.markers ?? [])}
      >
        {props.value}
      </pre>
    ),
  MonacoDiffView: () => <div />,
}));

const replace = vi.fn<(url: string) => void>();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => new URLSearchParams(search),
}));
let search = '';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPOSITORY = { state: 'ready', note: null } as const;
const FLOW_PATH = 'workflows/ship/WORKFLOW.md';

const flowOf = (name: string, ...agents: string[]) =>
  `---\nname: ${name}\ndescription: Does ${name}\nsequence:\n${agents
    .map(
      (agent, index) =>
        `  - id: step${index}\n    kind: ${index === agents.length - 1 && index > 0 ? 'review' : 'work'}\n    agent: ${agent}`,
    )
    .join('\n')}\n---\nNotes.\n`;
const flowText = (...agents: string[]) => flowOf('ship', ...agents);

const agent = (name: string): AgentSummaryOutput => ({
  name,
  description: `The ${name} agent`,
  provider: 'claude_code',
  model: 'default',
  source: 'definitions',
  usable: true,
  skills: [],
  problems: [],
});
const AGENT_NAMES = ['implementer', 'reviewer'];

const flowSummary = (overrides: Partial<WorkflowSummaryOutput> = {}): WorkflowSummaryOutput => ({
  name: 'ship',
  description: 'Does ship',
  valid: true,
  usable: true,
  notUsableReason: null,
  problems: [],
  ...overrides,
});
const BROKEN_FLOW = flowSummary({
  name: 'broken',
  description: null,
  valid: false,
  usable: false,
  problems: [
    {
      code: 'phase_agent_missing',
      path: 'WORKFLOW.md',
      key: 'nobody',
      message: 'The phase "step0" names the agent "nobody", which does not exist.',
    },
  ],
});

const entry = (
  path: string,
  owner: { agent?: string; workflow?: string } = {},
): AgentFileEntryOutput => ({
  path,
  kind: 'file',
  size: 120,
  openable: true,
  agent: owner.agent ?? null,
  skill: null,
  workflow: owner.workflow ?? null,
});

const ENTRIES = [
  ...AGENT_NAMES.map((name) => entry(`agents/${name}/AGENT.md`, { agent: name })),
  entry(FLOW_PATH, { workflow: 'ship' }),
  entry('workflows/broken/WORKFLOW.md', { workflow: 'broken' }),
  entry('workflows/bad/WORKFLOW.md', { workflow: 'bad' }),
];

const text = (path: string, content: string): AgentFileOutput => ({
  commit: SHA,
  path,
  kind: 'text',
  content,
});

const agentText = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} agent\nprovider: claude_code\n---\nHi`;

const CONTENTS: Record<string, AgentFileOutput> = {
  ...Object.fromEntries(
    AGENT_NAMES.map((name) => [
      `agents/${name}/AGENT.md`,
      text(`agents/${name}/AGENT.md`, agentText(name)),
    ]),
  ),
  [FLOW_PATH]: text(FLOW_PATH, flowText('implementer', 'reviewer')),
  'workflows/broken/WORKFLOW.md': text('workflows/broken/WORKFLOW.md', flowOf('broken', 'nobody')),
  'workflows/bad/WORKFLOW.md': text('workflows/bad/WORKFLOW.md', 'no front matter at all'),
};

function setup(
  options: {
    path?: string;
    query?: string;
    draft?: Partial<AgentDraftOutput>;
    details?: Record<string, AgentDetailOutput>;
    workflows?: WorkflowSummaryOutput[];
    contents?: Record<string, AgentFileOutput>;
  } = {},
) {
  search = options.query ?? (options.path ? `path=${encodeURIComponent(options.path)}` : '');
  const api = fakeAgentsApi(
    { repository: null },
    {
      list: agentList({
        commit: SHA,
        repository: REPOSITORY,
        agents: [...BUILT_INS, ...AGENT_NAMES.map(agent)],
      }),
      files: {
        tree: { commit: SHA, repository: REPOSITORY, truncated: false, entries: ENTRIES },
        contents: options.contents ?? CONTENTS,
      },
      workflows: {
        commit: SHA,
        repository: { state: 'ready', note: null },
        truncated: false,
        workflows: options.workflows ?? [flowSummary(), BROKEN_FLOW],
      },
      draft: options.draft,
      details: options.details,
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <AgentEditor />
    </QueryClientProvider>,
  );
  return { api, client, ...view };
}

const TOUCHED_FLOW_DRAFT: Partial<AgentDraftOutput> = {
  baseCommit: SHA,
  currentCommit: SHA,
  version: 2,
  files: [
    {
      path: FLOW_PATH,
      change: 'modified',
      size: 80,
      movedFrom: null,
      skill: null,
      workflow: 'ship',
    },
  ],
};

const treeNav = () => screen.getByRole('navigation', { name: 'Files' });
const publish = () => screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
const markersOf = () =>
  JSON.parse(screen.getByTestId('monaco').dataset.markers ?? '[]') as {
    line: number;
    message: string;
  }[];

beforeEach(() => {
  replace.mockClear();
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  window.sessionStorage.clear();
});

describe('workflows in the editor: the tree and the problems', () => {
  it('marks the workflow folders with their validation state', async () => {
    setup({ path: FLOW_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    const ship = within(treeNav()).getByRole('button', { name: /^ship/ });
    expect(within(ship).getByText('Valid')).toBeTruthy();
    await user.click(within(treeNav()).getByRole('button', { name: /^broken/ }));
    const broken = within(treeNav()).getByRole('button', { name: /^broken/ });
    expect(within(broken).getByText('1 problem')).toBeTruthy();
  });

  it('lists the problems of the Draft’s workflows, goes to the sequence line, and keeps Publish off', async () => {
    setup({
      path: 'agents/reviewer/AGENT.md',
      contents: { ...CONTENTS, [FLOW_PATH]: text(FLOW_PATH, flowText('implementer', 'ghost')) },
      draft: {
        ...TOUCHED_FLOW_DRAFT,
        workflowProblems: [
          {
            workflow: 'ship',
            code: 'phase_agent_missing',
            path: FLOW_PATH,
            key: 'ghost',
            message: 'The phase "step1" names the agent "ghost", which does not exist.',
          },
        ],
      },
    });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(publish().disabled).toBe(true);
    expect(screen.getByText('Fix the 1 problem of the Draft first.')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: /"step1" names the agent/ }));

    await waitFor(() => expect(screen.getByTestId('monaco').dataset.path).toBe(FLOW_PATH));
    await waitFor(() => expect(markersOf().length).toBeGreaterThan(0));
  });

  it('shows a workflow the Draft does not change by name, because it names an agent the Draft changes', async () => {
    setup({
      draft: {
        baseCommit: SHA,
        currentCommit: SHA,
        version: 2,
        files: [
          {
            path: 'agents/implementer/AGENT.md',
            change: 'deleted',
            size: 0,
            movedFrom: null,
            skill: null,
            workflow: null,
          },
        ],
        workflowProblems: [
          {
            workflow: 'ship',
            code: 'phase_agent_missing',
            path: FLOW_PATH,
            key: 'implementer',
            message: 'The phase "step0" names the agent "implementer", which does not exist.',
          },
        ],
      },
    });

    const list = await screen.findByRole('region', { name: 'Problems' });

    expect(within(list).getByText(FLOW_PATH)).toBeTruthy();
    expect(within(list).getByText(/names an agent the Draft changes/)).toBeTruthy();
    expect(publish().disabled).toBe(true);
  });

  it('lists the base problems of a workflow the Draft leaves alone, placed at its sequence', async () => {
    setup({});

    const list = await screen.findByRole('region', { name: 'Problems' });

    expect(within(list).getByText('workflows/broken/WORKFLOW.md')).toBeTruthy();
    expect(within(list).getByText('sequence')).toBeTruthy();
  });
});

describe('workflows in the editor: validation while typing', () => {
  it('flags a forbidden key in the open workflow, keeps Publish off, and clears it when fixed', async () => {
    setup({ path: FLOW_PATH, draft: TOUCHED_FLOW_DRAFT });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = (await screen.findByRole('textbox', { name: /^File / })) as HTMLTextAreaElement;

    fireEvent.change(editor, {
      target: {
        value: flowText('implementer', 'reviewer').replace('sequence:', 'tools: Bash\nsequence:'),
      },
    });

    await waitFor(() =>
      expect(markersOf().some((marker) => /tools/.test(marker.message))).toBe(true),
    );
    const ship = within(treeNav()).getByRole('button', { name: /^ship/ });
    expect(within(ship).getByText('1 problem')).toBeTruthy();

    fireEvent.change(editor, { target: { value: flowText('implementer', 'reviewer') } });

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Problems' })).toBeTruthy());
    await waitFor(() => expect(markersOf()).toEqual([]));
  });

  it('flags a phase whose agent is missing from the Draft, at the sequence line', async () => {
    setup({ path: FLOW_PATH, draft: TOUCHED_FLOW_DRAFT });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = (await screen.findByRole('textbox', { name: /^File / })) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: flowText('implementer', 'ghost') } });

    await waitFor(() =>
      expect(markersOf().map((marker) => [marker.line, marker.message])).toEqual([
        [4, expect.stringContaining('ghost')],
      ]),
    );
    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(await within(list).findByText(/agent "ghost", which does not exist/)).toBeTruthy();
    expect(publish().disabled).toBe(true);
  });

  it('flags a phase whose agent is invalid in the Draft', async () => {
    setup({
      path: FLOW_PATH,
      draft: {
        ...TOUCHED_FLOW_DRAFT,
        files: [
          ...(TOUCHED_FLOW_DRAFT.files ?? []),
          {
            path: 'agents/reviewer/AGENT.md',
            change: 'modified',
            size: 10,
            movedFrom: null,
            skill: null,
            workflow: null,
          },
        ],
        problems: [
          {
            agent: 'reviewer',
            code: 'key_missing',
            path: 'agents/reviewer/AGENT.md',
            key: 'description',
            message: 'The description is missing.',
          },
        ],
      },
    });
    await screen.findByTestId('monaco');

    const list = await screen.findByRole('region', { name: 'Problems' });

    await waitFor(() => expect(within(list).getByText(/which is not valid/)).toBeTruthy());
  });
});

describe('workflows in the editor: the diagram beside the entry file', () => {
  it('shows the phases of the Draft’s state, updated as the text changes', async () => {
    setup({ path: FLOW_PATH, draft: TOUCHED_FLOW_DRAFT });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    const panel = await screen.findByRole('region', { name: 'Diagram of the Draft' });
    const phases = await within(panel).findByRole('list', {
      name: 'Phases and checkpoints in order',
    });
    expect(within(phases).getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = (await screen.findByRole('textbox', { name: /^File / })) as HTMLTextAreaElement;

    fireEvent.change(editor, {
      target: { value: flowText('implementer', 'implementer', 'reviewer') },
    });

    await waitFor(() =>
      expect(
        within(
          within(panel).getByRole('list', { name: 'Phases and checkpoints in order' }),
        ).getAllByRole('listitem'),
      ).toHaveLength(3),
    );
    expect(within(panel).queryByText(/The text has a problem/)).toBeNull();
  });

  it('shows the last valid state with a note while the text has a problem', async () => {
    setup({ path: FLOW_PATH, draft: TOUCHED_FLOW_DRAFT });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    const panel = await screen.findByRole('region', { name: 'Diagram of the Draft' });
    await within(panel).findByRole('list', { name: 'Phases and checkpoints in order' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = (await screen.findByRole('textbox', { name: /^File / })) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: 'no front matter at all' } });

    expect(await within(panel).findByText(/last state that could be read/)).toBeTruthy();
    expect(
      within(
        within(panel).getByRole('list', { name: 'Phases and checkpoints in order' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(2);
  });

  it('says so when there is no earlier state to show', async () => {
    setup({ path: 'workflows/bad/WORKFLOW.md' });
    await screen.findByTestId('monaco');

    const panel = await screen.findByRole('region', { name: 'Diagram of the Draft' });

    expect(await within(panel).findByText(/no earlier state to show/)).toBeTruthy();
    expect(within(panel).queryByRole('list')).toBeNull();
  });

  it('shows a phase whose agent is missing as not usable', async () => {
    setup({ path: 'workflows/broken/WORKFLOW.md' });
    await screen.findByTestId('monaco');

    const panel = await screen.findByRole('region', { name: 'Diagram of the Draft' });

    expect(await within(panel).findByText('This agent does not exist.')).toBeTruthy();
  });

  it('is not shown beside any other file', async () => {
    setup({ path: 'agents/reviewer/AGENT.md' });
    await screen.findByTestId('monaco');

    expect(screen.queryByRole('region', { name: 'Diagram of the Draft' })).toBeNull();
  });
});

describe('workflows in the editor: New workflow', () => {
  it('creates workflows/<name>/WORKFLOW.md from the implement-then-review template', async () => {
    const { api } = setup({ path: FLOW_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog', { name: 'New workflow' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'fresh');
    await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }));

    await waitFor(() => {
      const put = api.calls().find((call) => call.method === 'PUT');
      expect(put?.body).toMatchObject({ path: 'workflows/fresh/WORKFLOW.md' });
      const body = put?.body as { text: string };
      expect(body.text).toContain('id: implement');
      expect(body.text).toContain('id: review');
    });
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/agents/editor?path=workflows%2Ffresh%2FWORKFLOW.md', {
        scroll: false,
      }),
    );
  });

  it('opens the new entry file without a problem once the agents it names exist', async () => {
    setup({ query: 'new=workflow' });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New workflow' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'fresh');
    await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }));

    await screen.findByTestId('monaco');
    await waitFor(() => expect(replace).toHaveBeenCalled());

    // The template names implementer and reviewer, which the Repository holds.
    expect(
      screen.queryByRole('button', { name: /names the agent "(implementer|reviewer)"/ }),
    ).toBeNull();
  });

  it('refuses a name that is taken or not a name', async () => {
    setup({ path: FLOW_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog', { name: 'New workflow' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.type(name, 'ship');
    await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }));
    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
    await user.clear(name);
    await user.type(name, 'Bad Name');
    await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }));
    expect(await within(dialog).findByText(/lower-case letters/)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('opens the step from ?new=workflow and drops it from the address when cancelled', async () => {
    setup({ query: 'new=workflow' });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New workflow' });

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/agents/editor', { scroll: false }));
  });
});

describe('workflows in the editor: renaming or deleting an agent', () => {
  const IMPLEMENTER = agent('implementer');

  it('names the workflows that become invalid when the agent is deleted', async () => {
    setup({
      path: 'agents/implementer/AGENT.md',
      details: {
        implementer: agentDetail(IMPLEMENTER, {}, { usedByWorkflows: ['ship'] }),
      },
    });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(await within(dialog).findByText(/would become invalid: ship\./)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('names them in the rename step too', async () => {
    setup({
      path: 'agents/implementer/AGENT.md',
      details: {
        implementer: agentDetail(IMPLEMENTER, {}, { usedByWorkflows: ['ship', 'other'] }),
      },
    });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText(/would become invalid: other, ship\./)).toBeTruthy();
  });

  it('says nothing when no workflow names the agent', async () => {
    const { api } = setup({
      path: 'agents/reviewer/AGENT.md',
      details: { reviewer: agentDetail(agent('reviewer'), {}, { usedByWorkflows: [] }) },
    });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await waitFor(() =>
      expect(api.calls().some((call) => call.path === '/api/agents/reviewer')).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByText(/would become invalid/)).toBeNull();
  });
});
