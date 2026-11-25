import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEditor } from '..';
import type {
  AgentDraftOutput,
  AgentFileEntryOutput,
  AgentFileOutput,
  AgentSummaryOutput,
} from '../../../platform/api';
import { agentList, BUILT_INS, fakeAgentsApi, problem } from './fake-agents-api';

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
        data-readonly="false"
        data-path={props.path}
        data-markers={JSON.stringify(props.markers ?? [])}
        aria-label={`File ${props.path}`}
        value={props.value}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    ) : (
      <pre
        data-testid="monaco"
        data-readonly="true"
        data-path={props.path}
        data-markers={JSON.stringify(props.markers ?? [])}
      >
        {props.value}
      </pre>
    ),
  MonacoDiffView: (props: { original: string; modified: string; path: string }) => (
    <div
      role="img"
      aria-label={`Changes of ${props.path}`}
      data-testid="diff"
      data-original={props.original}
      data-modified={props.modified}
    />
  ),
}));

const push = vi.fn<(url: string) => void>();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
let search = '';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const REPOSITORY = { state: 'ready', note: null } as const;
const AGENT_MD =
  '---\nname: reviewer\ndescription: Reviews a change\nprovider: claude_code\n---\nHi';
const AGENT_PATH = 'agents/reviewer/AGENT.md';

const GOOD: AgentSummaryOutput = {
  name: 'reviewer',
  description: 'Reviews a change',
  provider: 'claude_code',
  model: 'default',
  source: 'definitions',
  usable: true,
  problems: [],
};

const entry = (path: string, agent: string | null = null): AgentFileEntryOutput => ({
  path,
  kind: 'file',
  size: 120,
  openable: true,
  agent,
});

const ENTRIES = [
  entry('README.md'),
  entry('logo.png'),
  entry(AGENT_PATH, 'reviewer'),
  entry('agents/reviewer/run.sh', 'reviewer'),
];

const text = (path: string, content: string): AgentFileOutput => ({
  commit: SHA,
  path,
  kind: 'text',
  content,
});

const CONTENTS: Record<string, AgentFileOutput> = {
  [AGENT_PATH]: text(AGENT_PATH, AGENT_MD),
  'agents/reviewer/run.sh': text('agents/reviewer/run.sh', 'echo hi'),
  'README.md': text('README.md', '# Readme'),
  'logo.png': { commit: SHA, path: 'logo.png', kind: 'binary', size: 2048 },
};

function setup(options: { path?: string; draft?: Partial<AgentDraftOutput> } = {}) {
  search = options.path ? `path=${encodeURIComponent(options.path)}` : '';
  const api = fakeAgentsApi(
    { repository: null },
    {
      list: agentList({
        commit: SHA,
        repository: REPOSITORY,
        agents: [...BUILT_INS, GOOD],
      }),
      files: {
        tree: { commit: SHA, repository: REPOSITORY, truncated: false, entries: ENTRIES },
        contents: CONTENTS,
      },
      draft: options.draft,
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <a href="/runs">Runs</a>
      <AgentEditor />
    </QueryClientProvider>,
  );
  return { api, client, ...view };
}

const MODIFIED_DRAFT: Partial<AgentDraftOutput> = {
  baseCommit: SHA,
  currentCommit: SHA,
  version: 3,
  files: [{ path: 'agents/reviewer/run.sh', change: 'modified', size: 7, movedFrom: null }],
};

const treeNav = () => screen.getByRole('navigation', { name: 'Files' });
const writes = (api: ReturnType<typeof fakeAgentsApi>) =>
  api.calls().filter((call) => call.method !== 'GET');

async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByTestId('monaco');
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  return (await screen.findByRole('textbox', { name: /^File / })) as HTMLTextAreaElement;
}

beforeEach(() => {
  push.mockClear();
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('Draft editing: saving a file', () => {
  it('is read-only until Edit, then stores the file through PUT and marks it modified', async () => {
    const { api } = setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    expect((await screen.findByTestId('monaco')).dataset.readonly).toBe('true');

    const editor = await startEditing(user);
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor, { target: { value: `${AGENT_MD} more` } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);

    await waitFor(() =>
      expect(writes(api)).toEqual([
        expect.objectContaining({
          method: 'PUT',
          path: '/api/agents/definitions-repository/draft/files',
          body: { path: AGENT_PATH, text: `${AGENT_MD} more` },
        }),
      ]),
    );
    const mark = await within(treeNav()).findByText('Modified');
    expect(mark.classList.contains('ml-auto')).toBe(true);
    expect(mark.classList.contains('shrink-0')).toBe(true);
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByText(/Draft based on commit/)).toBeTruthy();
  });

  it('keeps unsaved edits in sessionStorage so they survive a reload', async () => {
    const first = setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'unsaved text' } });
    first.unmount();

    const second = setup({ path: AGENT_PATH });
    const restored = (await screen.findByRole('textbox', {
      name: /^File /,
    })) as HTMLTextAreaElement;
    expect(restored.value).toBe('unsaved text');
    expect(writes(second.api)).toEqual([]);
  });

  it('asks the browser before leaving with unsaved edits, and not without them', async () => {
    setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it('asks before a link leaves the editor with unsaved edits', async () => {
    setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });

    await user.click(screen.getByRole('link', { name: 'Runs' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Leave with unsaved edits?')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await user.click(screen.getByRole('link', { name: 'Runs' }));
    await user.click(await screen.findByRole('button', { name: 'Leave' }));
    expect(push).toHaveBeenCalledWith('/runs');
  });

  it('lets a link through when nothing is unsaved', async () => {
    setup({ path: AGENT_PATH });
    await screen.findByTestId('monaco');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    screen.getByRole('link', { name: 'Runs' }).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('Draft editing: problems while typing', () => {
  it('shows a problem at its place and in the list, and clears it when fixed', async () => {
    setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull();

    fireEvent.change(editor, { target: { value: AGENT_MD.replace('claude_code', 'nope') } });

    const problems = await screen.findByRole('region', { name: 'Problems' });
    expect(within(problems).getByText(/provider is not one Studio knows/)).toBeTruthy();
    const markers = JSON.parse(screen.getByTestId('monaco').dataset.markers ?? '[]') as {
      line: number;
      message: string;
    }[];
    expect(markers).toEqual([
      expect.objectContaining({ message: expect.stringContaining('provider') }),
    ]);

    fireEvent.change(screen.getByTestId('monaco'), { target: { value: AGENT_MD } });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull());
    expect(screen.getByTestId('monaco').dataset.markers).toBe('[]');
  });
});

describe('Draft editing: files in the tree', () => {
  it('adds a file from a path, opens it and marks it added', async () => {
    const { api } = setup({ path: 'README.md' });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Path'), 'agents/reviewer/notes.md');
    await user.click(within(dialog).getByRole('button', { name: 'Add file' }));

    await waitFor(() =>
      expect(writes(api)).toEqual([
        expect.objectContaining({
          method: 'PUT',
          body: { path: 'agents/reviewer/notes.md', text: '' },
        }),
      ]),
    );
    expect(await screen.findByTestId('monaco')).toBeTruthy();
    expect(await within(treeNav()).findByText('Added')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says why a path is refused, and sends nothing', async () => {
    const { api } = setup({ path: 'README.md' });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Path'), '../outside.md');
    await user.click(within(dialog).getByRole('button', { name: 'Add file' }));

    expect(await within(dialog).findByText(/not a plain relative path/)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
    expect(writes(api)).toEqual([]);
  });

  it('renames a file: the new path is added, the old one deleted', async () => {
    const { api } = setup({ path: 'README.md' });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Path');
    await user.clear(field);
    await user.type(field, 'agents/reviewer/README.md');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() =>
      expect(writes(api)).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/api/agents/definitions-repository/draft/files/move',
          body: { from: 'README.md', to: 'agents/reviewer/README.md' },
        }),
      ]),
    );
    expect(await within(treeNav()).findByText('Deleted')).toBeTruthy();
    expect(within(treeNav()).getByText('Added')).toBeTruthy();
  });

  it('deletes a file only after a confirmation', async () => {
    const { api } = setup({ path: 'README.md' });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const first = await screen.findByRole('alertdialog');
    await user.click(within(first).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes(api)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const second = await screen.findByRole('alertdialog');
    await expect(second).toHaveNoAxeViolations();
    await user.click(within(second).getByRole('button', { name: 'Delete file' }));

    await waitFor(() =>
      expect(writes(api)).toEqual([
        expect.objectContaining({
          method: 'DELETE',
          path: '/api/agents/definitions-repository/draft/files',
          search: '?path=README.md',
        }),
      ]),
    );
    expect(await screen.findByText(/is deleted in the Draft/)).toBeTruthy();
    expect(within(treeNav()).getByText('Deleted')).toBeTruthy();
  });

  it('reverts one file after a confirmation', async () => {
    const { api } = setup({ path: 'agents/reviewer/run.sh', draft: MODIFIED_DRAFT });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revert file' }),
    );

    await waitFor(() =>
      expect(writes(api)).toEqual([
        expect.objectContaining({
          method: 'POST',
          path: '/api/agents/definitions-repository/draft/files/revert',
          body: { path: 'agents/reviewer/run.sh' },
        }),
      ]),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull());
  });

  it('discards the whole Draft after a confirmation, and its unsaved edits', async () => {
    const { api } = setup({ path: 'agents/reviewer/run.sh', draft: MODIFIED_DRAFT });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'unsaved' } });

    await user.click(screen.getByRole('button', { name: 'Discard Draft' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Discard the Draft' }));

    await waitFor(() =>
      expect(writes(api)).toEqual([
        expect.objectContaining({
          method: 'DELETE',
          path: '/api/agents/definitions-repository/draft',
        }),
      ]),
    );
    await waitFor(() => expect(within(treeNav()).queryByText('Modified')).toBeNull());
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('Draft editing: binary files', () => {
  it('replaces a binary file with an upload within the limit', async () => {
    const { api } = setup({ path: 'logo.png' });
    const user = userEvent.setup();
    await screen.findByText(/binary file/i);
    await user.click(screen.getByRole('button', { name: 'Replace file' }));
    const dialog = await screen.findByRole('dialog');

    await user.upload(
      within(dialog).getByLabelText('File to upload'),
      new File([new Uint8Array([1, 2, 3])], 'logo.png', { type: 'image/png' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Replace file' }));

    await waitFor(() =>
      expect(writes(api)).toEqual([
        expect.objectContaining({
          method: 'PUT',
          body: { path: 'logo.png', contentBase64: 'AQID' },
        }),
      ]),
    );
  });

  it('refuses an upload over 1 MiB before sending it', async () => {
    const { api } = setup({ path: 'logo.png' });
    const user = userEvent.setup();
    await screen.findByText(/binary file/i);
    await user.click(screen.getByRole('button', { name: 'Replace file' }));
    const dialog = await screen.findByRole('dialog');

    await user.upload(
      within(dialog).getByLabelText('File to upload'),
      new File([new Uint8Array(1024 * 1024 + 1)], 'logo.png'),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Replace file' }));

    expect(await within(dialog).findByText(/at most 1 MiB/)).toBeTruthy();
    expect(writes(api)).toEqual([]);
  });
});

describe('Draft editing: the Changes view', () => {
  it('lists the changed files and shows one against the base commit', async () => {
    setup({ path: 'agents/reviewer/run.sh', draft: MODIFIED_DRAFT });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Changes (1)' }));

    const list = await screen.findByRole('navigation', { name: 'Changed files' });
    expect(within(list).getByText('agents/reviewer/run.sh')).toBeTruthy();
    expect(within(list).getByText('Modified')).toBeTruthy();
    const diff = await screen.findByTestId('diff');
    expect(diff.dataset.original).toBe('echo hi');
    expect(diff.dataset.modified).toBe('echo hi');
  });

  it('says so when the Draft has no changes, without axe violations', async () => {
    const { container } = setup();
    await screen.findByRole('navigation', { name: 'Files' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Changes (0)' }));

    expect(await screen.findByText('The Draft has no changes.')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });
});

describe('Draft editing: new agent', () => {
  it('creates agents/<name>/AGENT.md from a template that passes the validation', async () => {
    const { api } = setup();
    const user = userEvent.setup();
    await screen.findByRole('navigation', { name: 'Files' });
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    const dialog = await screen.findByRole('dialog');
    await expect(dialog).toHaveNoAxeViolations();

    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    expect(await within(dialog).findByText(/Enter a name/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Name'), 'helper');
    await user.selectOptions(within(dialog).getByLabelText('Provider'), 'codex');
    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(writes(api)).toHaveLength(1));
    const body = writes(api)[0]?.body as { path: string; text: string };
    expect(body.path).toBe('agents/helper/AGENT.md');
    expect(body.text).toContain('name: helper');
    expect(body.text).toContain('provider: codex');
    expect(await screen.findByTestId('monaco')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Problems' })).toBeNull();
  });

  it('refuses a name that is taken', async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByRole('navigation', { name: 'Files' });
    await user.click(screen.getByRole('button', { name: 'New agent' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Name'), 'reviewer');
    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));

    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
  });
});

describe('Draft editing: the Repository and other writers', () => {
  it('shows the base commit and lists the Draft files that changed upstream too', async () => {
    setup({
      draft: {
        ...MODIFIED_DRAFT,
        currentCommit: NEW_SHA,
        movedUpstream: ['agents/reviewer/run.sh'],
      },
    });

    const banner = await screen.findByText(/The Repository moved on/);
    const region = banner.closest('[role]') as HTMLElement;
    expect(within(region).getByText('fedcba9')).toBeTruthy();
    expect(within(region).getByText('agents/reviewer/run.sh')).toBeTruthy();
    expect(screen.getByText(/Draft based on commit/)).toBeTruthy();
  });

  it('says that the Draft changed elsewhere and reloads it on request', async () => {
    const { api } = setup({ path: 'agents/reviewer/run.sh', draft: MODIFIED_DRAFT });
    await screen.findByRole('navigation', { name: 'Files' });
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();

    api.changeDraftElsewhere({
      files: [
        ...MODIFIED_DRAFT.files!,
        { path: 'README.md', change: 'modified', size: 1, movedFrom: null },
      ],
    });
    act(() => focusManager.setFocused(true));

    const reload = await screen.findByRole('button', { name: 'Reload the Draft' });
    await waitFor(() => expect(within(treeNav()).getAllByText('Modified')).toHaveLength(1));
    await userEvent.setup().click(reload);

    await waitFor(() => expect(within(treeNav()).getAllByText('Modified')).toHaveLength(2));
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
  });

  it('gives a lost race its own message and offers a reload', async () => {
    const { api } = setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });
    api.failNextDraftWrite(
      409,
      problem(409, 'Draft changed', { type: 'urn:agentic-studio:problem:agent-draft-conflict' }),
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Another change to the Draft landed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the Draft' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /^File / }) as HTMLTextAreaElement).value).toBe(
      'changed',
    );
  });

  it('says when the base commit is gone, and offers to discard the Draft', async () => {
    const { api } = setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });
    api.failNextDraftWrite(
      409,
      problem(409, 'Draft base is gone', {
        type: 'urn:agentic-studio:problem:agent-draft-base-missing',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/no longer in the Repository/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard the Draft' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('shows a refusal with its reason', async () => {
    const { api } = setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });
    api.failNextDraftWrite(
      422,
      problem(422, 'File too large', { detail: 'The file is 9 bytes; at most 8.' }),
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('The file is 9 bytes; at most 8.')).toBeTruthy();
  });
});

describe('Draft editing: nothing leaves through other routes', () => {
  it('sends writes only to the Draft routes', async () => {
    const { api } = setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(api)).toHaveLength(1));

    for (const call of writes(api)) {
      expect(call.path.startsWith('/api/agents/definitions-repository/draft')).toBe(true);
    }
  });
});

describe('Draft editing: accessibility', () => {
  it('has no axe violations in edit mode with a problem and a changed tree', async () => {
    const { container } = setup({ path: AGENT_PATH, draft: MODIFIED_DRAFT });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: AGENT_MD.replace('claude_code', 'nope') } });

    await screen.findByRole('region', { name: 'Problems' });
    await expect(container).toHaveNoAxeViolations();
  });

  it('has no axe violations with the banners of a moved Repository', async () => {
    const { container } = setup({
      draft: {
        ...MODIFIED_DRAFT,
        currentCommit: NEW_SHA,
        movedUpstream: ['agents/reviewer/run.sh'],
      },
    });
    await screen.findByText(/The Repository moved on/);
    await expect(container).toHaveNoAxeViolations();
  });
});

const contentReads = (api: ReturnType<typeof fakeAgentsApi>, path: string) =>
  api
    .calls()
    .filter(
      (call) =>
        call.path === '/api/agents/definitions-repository/draft/files/content' &&
        new URLSearchParams(call.search).get('path') === path,
    );

describe('Draft editing: another tab writes in between', () => {
  it('drops cached files and keeps the notice when a save answers a newer version than expected', async () => {
    const { api } = setup({ path: 'agents/reviewer/run.sh', draft: MODIFIED_DRAFT });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    expect(contentReads(api, 'agents/reviewer/run.sh')).toHaveLength(1);

    api.changeDraftElsewhere({});
    act(() => focusManager.setFocused(true));
    await screen.findByRole('button', { name: 'Reload the Draft' });

    await user.click(within(treeNav()).getByRole('button', { name: 'README.md' }));
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'readme edited' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(api)).toHaveLength(1));

    expect(await screen.findByText(/changed elsewhere/)).toBeTruthy();
    await user.click(within(treeNav()).getByRole('button', { name: /^run.sh/ }));
    await waitFor(() => expect(contentReads(api, 'agents/reviewer/run.sh')).toHaveLength(2));
  });
});

describe('Draft editing: unsaved edits are visible and discardable', () => {
  it('marks them in the tree, the chooser and the leave dialog, and discards one', async () => {
    setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });

    expect(await within(treeNav()).findByText('Unsaved')).toBeTruthy();
    const chooser = screen.getByRole('combobox', { name: 'File' });
    expect(within(chooser).getByRole('option', { name: `${AGENT_PATH} (Unsaved)` })).toBeTruthy();

    await user.click(screen.getByRole('link', { name: 'Runs' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(AGENT_PATH)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Stay' }));

    await user.click(screen.getByRole('button', { name: `Discard unsaved edit of ${AGENT_PATH}` }));
    await waitFor(() => expect(screen.queryByText('Unsaved edits')).toBeNull());
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  it('keeps an unsaved edit of a file that no longer exists, with a note and a discard', async () => {
    window.sessionStorage.setItem('agent-editor:buffer:agents/gone/AGENT.md', 'orphan');
    setup({ path: AGENT_PATH });
    await screen.findByRole('navigation', { name: 'Files' });

    expect(await screen.findByText(/no longer exists in the Draft or the Repository/)).toBeTruthy();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Discard unsaved edit of agents/gone/AGENT.md' }));
    await waitFor(() => expect(screen.queryByText('Unsaved edits')).toBeNull());
  });

  it('writes edits to storage on pagehide and beforeunload without waiting for the pause', async () => {
    setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'quick' } });
    expect(window.sessionStorage.length).toBe(0);
    window.dispatchEvent(new Event('pagehide'));
    expect(window.sessionStorage.length).toBe(1);

    fireEvent.change(screen.getByRole('textbox', { name: /^File / }), {
      target: { value: 'again' },
    });
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    expect(window.sessionStorage.getItem(`agent-editor:buffer:${AGENT_PATH}`)).toBe('again');
  });

  it('keeps edits out of storage until typing pauses, and says when storage refuses', async () => {
    setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });
    expect(window.sessionStorage.length).toBe(0);
    await waitFor(() => expect(window.sessionStorage.length).toBe(1));

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    fireEvent.change(screen.getByRole('textbox', { name: /^File / }), {
      target: { value: 'changed more' },
    });
    expect(await screen.findByText(/refused to keep your unsaved edits/)).toBeTruthy();
    vi.restoreAllMocks();
  });
});

describe('Draft editing: honest confirmations', () => {
  it('says that deleting a file the Draft added removes it for good', async () => {
    setup({
      path: 'agents/reviewer/new.md',
      draft: {
        ...MODIFIED_DRAFT,
        files: [{ path: 'agents/reviewer/new.md', change: 'added', size: 3, movedFrom: null }],
      },
    });
    const user = userEvent.setup();
    await screen.findByRole('navigation', { name: 'Files' });
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/removed for good/)).toBeTruthy();
    expect(within(dialog).queryByText(/Revert brings it back/)).toBeNull();
  });

  it('says that Revert brings back a file of the base commit', async () => {
    setup({ path: 'README.md' });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Revert brings it back/)).toBeTruthy();
  });

  it('asks before saving while the view and the Draft are at different commits', async () => {
    const { api } = setup({
      path: AGENT_PATH,
      draft: { ...MODIFIED_DRAFT, baseCommit: NEW_SHA, currentCommit: NEW_SHA },
    });
    const user = userEvent.setup();
    const editor = await startEditing(user);
    fireEvent.change(editor, { target: { value: 'changed' } });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Saving keeps the Draft’s base commit/)).toBeTruthy();
    expect(writes(api)).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(writes(api)).toHaveLength(1));
  });

  it('offers a reload inside a dialog that lost a race', async () => {
    const { api } = setup({ path: 'README.md' });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'New file' }));
    const dialog = await screen.findByRole('dialog');
    api.failNextDraftWrite(
      409,
      problem(409, 'Draft changed', { type: 'urn:agentic-studio:problem:agent-draft-conflict' }),
    );
    await user.type(within(dialog).getByLabelText('Path'), 'agents/reviewer/x.md');
    await user.click(within(dialog).getByRole('button', { name: 'Add file' }));

    expect(await within(dialog).findByRole('button', { name: 'Reload the Draft' })).toBeTruthy();
  });

  it('shows a hint to leave the editor with the keyboard in edit mode', async () => {
    setup({ path: AGENT_PATH });
    const user = userEvent.setup();
    await startEditing(user);
    expect(screen.getByText(/Press Ctrl\+M/)).toBeTruthy();
  });
});
