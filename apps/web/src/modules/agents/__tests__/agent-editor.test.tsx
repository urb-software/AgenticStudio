import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEditor } from '..';
import type {
  AgentFileEntryOutput,
  AgentFileOutput,
  AgentFilesOutput,
  AgentSummaryOutput,
} from '../../../platform/api';
import { agentList, BUILT_INS, fakeAgentsApi } from './fake-agents-api';

// Monaco cannot run in jsdom: the lazy view is replaced by a probe of what it is given.
vi.mock('../features/agent-editor/monaco-view', () => ({
  default: (props: { value: string; language: string; path: string; revealLine?: number }) => (
    <pre
      data-testid="monaco"
      data-language={props.language}
      data-path={props.path}
      data-reveal-line={props.revealLine ?? ''}
    >
      {props.value}
    </pre>
  ),
}));

let search = '';
const replace = vi.fn<(url: string, options?: unknown) => void>();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => new URLSearchParams(search),
}));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const REPOSITORY = { state: 'ready', note: null } as const;

const GOOD: AgentSummaryOutput = {
  name: 'reviewer',
  description: 'Reviews a change',
  provider: 'claude_code',
  model: 'opus',
  source: 'definitions',
  usable: true,
  skills: [],
  problems: [],
};
const BROKEN: AgentSummaryOutput = {
  name: 'broken',
  description: null,
  provider: null,
  model: null,
  source: 'definitions',
  usable: false,
  skills: [],
  problems: [
    {
      code: 'provider_unknown',
      path: 'AGENT.md',
      key: 'provider',
      message: 'The provider is not one Studio knows.',
    },
    { code: 'file_too_large', path: 'notes/big.txt', key: null, message: 'The file is too large.' },
  ],
};

const entry = (
  path: string,
  overrides: Partial<AgentFileEntryOutput> = {},
): AgentFileEntryOutput => ({
  path,
  kind: 'file',
  size: 120,
  openable: true,
  agent: null,
  skill: null,
  ...overrides,
});

const ENTRIES = [
  entry('README.md'),
  entry('plain.txt'),
  entry('agents/broken/big.bin', { agent: 'broken', size: 3_000_000 }),
  entry('agents/reviewer/AGENT.md', { agent: 'reviewer' }),
  entry('agents/reviewer/run.sh', { agent: 'reviewer' }),
  entry('agents/broken/AGENT.md', { agent: 'broken' }),
  entry('agents/broken/notes/big.txt', { agent: 'broken', size: 2_000_000, openable: false }),
  entry('agents/broken/link', { agent: 'broken', kind: 'symlink', size: 0, openable: false }),
];

function tree(overrides: Partial<AgentFilesOutput> = {}): AgentFilesOutput {
  return { commit: SHA, repository: REPOSITORY, truncated: false, entries: ENTRIES, ...overrides };
}

const text = (path: string, content: string): AgentFileOutput => ({
  commit: SHA,
  path,
  kind: 'text',
  content,
});

const CONTENTS: Record<string, AgentFileOutput> = {
  'agents/reviewer/AGENT.md': text('agents/reviewer/AGENT.md', '---\nname: reviewer\n---\nHi'),
  'agents/reviewer/run.sh': text('agents/reviewer/run.sh', 'echo hi'),
  'agents/broken/AGENT.md': text(
    'agents/broken/AGENT.md',
    '---\nname: broken\nprovider: nope\nmodel: x\n---\nbody',
  ),
  'README.md': { commit: SHA, path: 'README.md', kind: 'binary', size: 2048 },
  'agents/broken/big.bin': {
    commit: SHA,
    path: 'agents/broken/big.bin',
    kind: 'too_large',
    size: 3_000_000,
  },
};

function render_(
  overrides: {
    tree?: Partial<AgentFilesOutput>;
    agents?: AgentSummaryOutput[];
    listCommit?: string | null;
    path?: string;
  } = {},
) {
  search = overrides.path ? `path=${encodeURIComponent(overrides.path)}` : '';
  const api = fakeAgentsApi(
    { repository: null },
    {
      list: agentList({
        commit: overrides.listCommit === undefined ? SHA : overrides.listCommit,
        repository: REPOSITORY,
        agents: [...BUILT_INS, ...(overrides.agents ?? [GOOD, BROKEN])],
      }),
      files: { tree: tree(overrides.tree), contents: CONTENTS },
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

const treeNav = () => screen.getByRole('navigation', { name: 'Files' });

beforeEach(() => {
  replace.mockClear();
});

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  vi.unstubAllGlobals();
});

describe('Agent editor: the file tree', () => {
  it('shows the commit and the files, marking each agent folder with its validation state', async () => {
    const { container } = render_({ path: 'agents/reviewer/AGENT.md' });

    const nav = await screen.findByRole('navigation', { name: 'Files' });
    expect(screen.getByText('0123456')).toBeTruthy();
    const reviewer = within(nav).getByRole('button', { name: /^reviewer/ });
    expect(within(reviewer).getByText('Valid')).toBeTruthy();
    const broken = within(nav).getByRole('button', { name: /^broken/ });
    expect(within(broken).getByText('2 problems')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('shows entries that cannot be opened, without a way to open them', async () => {
    render_({ path: 'agents/broken/AGENT.md' });

    const nav = await screen.findByRole('navigation', { name: 'Files' });
    const user = userEvent.setup();
    await user.click(within(nav).getByRole('button', { name: /^notes/ }));
    expect(within(nav).getByText('big.txt')).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: /big\.txt/ })).toBeNull();
    expect(within(nav).getByText('link')).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: /^link/ })).toBeNull();
    expect(within(nav).getAllByText('Not openable').length).toBe(2);
  });

  it('notes that the tree is truncated', async () => {
    render_({ tree: { truncated: true } });

    expect(await screen.findByText(/more files than are listed/i)).toBeTruthy();
  });

  it('says so when nothing has been fetched yet', async () => {
    render_({ tree: { commit: null, entries: [] } });

    expect(await screen.findByText(/Nothing has been fetched/i)).toBeTruthy();
  });

  it('opens a file from the tree, and puts it in the URL', async () => {
    render_();
    const nav = await screen.findByRole('navigation', { name: 'Files' });
    const user = userEvent.setup();

    await user.click(within(nav).getByRole('button', { name: /^agents/ }));
    await user.click(within(nav).getByRole('button', { name: /^reviewer/ }));
    await user.click(within(nav).getByRole('button', { name: 'run.sh' }));

    const monaco = await screen.findByTestId('monaco');
    expect(monaco.textContent).toBe('echo hi');
    expect(monaco.dataset.language).toBe('shell');
    expect(replace).toHaveBeenLastCalledWith(
      '/agents/editor?path=agents%2Freviewer%2Frun.sh',
      expect.anything(),
    );
  });
});

describe('Agent editor: the file', () => {
  it('opens the file of the URL, with its language', async () => {
    render_({ path: 'agents/reviewer/AGENT.md' });

    const monaco = await screen.findByTestId('monaco');
    expect(monaco.dataset.language).toBe('markdown');
    expect(monaco.dataset.path).toBe('agents/reviewer/AGENT.md');
    expect(monaco.textContent).toContain('name: reviewer');
    const selected = within(treeNav()).getByRole('button', { name: 'AGENT.md' });
    expect(selected.getAttribute('aria-current')).toBe('true');
  });

  it('shows the size of a binary file instead of its content', async () => {
    render_({ path: 'README.md' });

    expect(await screen.findByText(/binary file/i)).toBeTruthy();
    expect(screen.getByText('2 KiB')).toBeTruthy();
    expect(screen.queryByTestId('monaco')).toBeNull();
  });

  it('shows the size of a file that is too large instead of its content', async () => {
    render_({ path: 'agents/broken/big.bin' });

    expect(await screen.findByText(/too large to show/i)).toBeTruthy();
    expect(screen.getByText('2.9 MiB')).toBeTruthy();
    expect(screen.queryByTestId('monaco')).toBeNull();
  });

  it('says so when the file cannot be read', async () => {
    render_({ path: 'plain.txt' });

    expect(await screen.findByText(/Couldn't read this file/i)).toBeTruthy();
  });

  it('says so when the path is not in this commit', async () => {
    render_({ path: 'agents/none/missing.md' });

    expect(await screen.findByText(/is not in this commit/i)).toBeTruthy();
  });

  it('asks to choose a file when none is open', async () => {
    render_();

    expect(await screen.findByText(/Choose a file/i)).toBeTruthy();
    expect(screen.queryByTestId('monaco')).toBeNull();
  });
});

describe('Agent editor: problems', () => {
  it('moves to the line of a front matter key', async () => {
    render_({ path: 'agents/reviewer/AGENT.md' });
    await screen.findByTestId('monaco');
    const user = userEvent.setup();

    const problems = screen.getByRole('region', { name: 'Problems' });
    await user.click(within(problems).getByRole('button', { name: /provider/ }));

    await waitFor(() => {
      const monaco = screen.getByTestId('monaco');
      expect(monaco.dataset.path).toBe('agents/broken/AGENT.md');
      expect(monaco.dataset.revealLine).toBe('3');
    });
    expect(replace).toHaveBeenLastCalledWith(
      '/agents/editor?path=agents%2Fbroken%2FAGENT.md',
      expect.anything(),
    );
  });

  it('says so when the problem is about a file that cannot be opened', async () => {
    render_({ path: 'agents/reviewer/AGENT.md' });
    await screen.findByTestId('monaco');
    const user = userEvent.setup();

    const problems = screen.getByRole('region', { name: 'Problems' });
    await user.click(within(problems).getByRole('button', { name: /notes\/big\.txt/ }));

    expect(await screen.findByText(/cannot be opened here/i)).toBeTruthy();
  });

  it('lists no problems for valid agents', async () => {
    render_({ agents: [GOOD] });

    await screen.findByRole('navigation', { name: 'Files' });
    expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull();
  });
});

describe('Agent editor: the commit it reads', () => {
  it('offers a Reload when a commit arrives after the view opened with none', async () => {
    const { api } = render_({ tree: { commit: null, entries: [] }, listCommit: null });
    await screen.findByText(/Nothing has been fetched/i);
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();

    api.setAgents(agentList({ commit: NEW_SHA, repository: REPOSITORY, agents: BUILT_INS }));
    act(() => focusManager.setFocused(true));

    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('offers a Reload when the marks and the tree were read at different commits', async () => {
    render_({ listCommit: NEW_SHA });

    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('offers a Reload when a newer commit exists, and switches only when asked', async () => {
    const { api } = render_({ path: 'agents/reviewer/AGENT.md' });
    await screen.findByTestId('monaco');
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();

    api.setAgents(
      agentList({ commit: NEW_SHA, repository: REPOSITORY, agents: [...BUILT_INS, GOOD, BROKEN] }),
    );
    api.setFiles({
      tree: tree({ commit: NEW_SHA, entries: [...ENTRIES, entry('NEW.md')] }),
      contents: CONTENTS,
    });
    act(() => focusManager.setFocused(true));

    const reload = await screen.findByRole('button', { name: 'Reload' });
    expect(screen.getByText('0123456')).toBeTruthy();
    expect(within(treeNav()).queryByText('NEW.md')).toBeNull();

    await userEvent.setup().click(reload);

    await waitFor(() => expect(within(treeNav()).getByText('NEW.md')).toBeTruthy());
    expect(screen.getByText('fedcba9')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('reads each file at the commit it shows', async () => {
    const { api } = render_({ path: 'agents/reviewer/run.sh' });
    await screen.findByTestId('monaco');

    const reads = api
      .calls()
      .filter((call) => call.path === '/api/agents/definitions-repository/files/content');
    expect(reads).toHaveLength(1);
    expect(new URLSearchParams(reads[0]!.search).get('commit')).toBe(SHA);
  });
});

describe('Agent editor: the chooser (phone width)', () => {
  it('lists the openable files and opens the chosen one, without axe violations', async () => {
    const { container } = render_();
    const chooser = await screen.findByRole('combobox', { name: 'File' });
    const labels = within(chooser)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(labels).toContain('agents/reviewer/run.sh');
    expect(labels).not.toContain('agents/broken/notes/big.txt');
    expect(labels).not.toContain('agents/broken/link');

    await userEvent.setup().selectOptions(chooser, 'agents/reviewer/run.sh');

    expect((await screen.findByTestId('monaco')).dataset.path).toBe('agents/reviewer/run.sh');
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('Agent editor: states', () => {
  it('says so when the files cannot be listed, with a retry', async () => {
    search = '';
    fakeAgentsApi({ repository: null }, { list: agentList() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AgentEditor />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Couldn't load the files/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
