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
import { publishMessageError } from '../features/agent-editor/draft-model';
import { agentList, BUILT_INS, fakeAgentsApi, problem } from './fake-agents-api';

vi.mock('../features/agent-editor/monaco-view', () => ({
  default: (props: {
    value: string;
    path: string;
    readOnly?: boolean;
    onChange?: (text: string) => void;
  }) =>
    props.readOnly === false ? (
      <textarea
        data-testid="monaco"
        aria-label={`File ${props.path}`}
        value={props.value}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    ) : (
      <pre data-testid="monaco">{props.value}</pre>
    ),
  MonacoDiffView: (props: { original: string; modified: string; path: string }) => (
    <div role="img" aria-label={`Changes of ${props.path}`} data-testid="diff" />
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const REPOSITORY = { state: 'ready', note: null } as const;
const AGENT_MD =
  '---\nname: reviewer\ndescription: Reviews a change\nprovider: claude_code\n---\nHi';
const AGENT_PATH = 'agents/reviewer/AGENT.md';
const PUBLISH_URL = '/api/agents/definitions-repository/draft/publish';

const GOOD: AgentSummaryOutput = {
  name: 'reviewer',
  description: 'Reviews a change',
  provider: 'claude_code',
  model: 'default',
  source: 'definitions',
  usable: true,
  skills: [],
  problems: [],
};

const entry = (path: string, agent: string | null = null): AgentFileEntryOutput => ({
  path,
  kind: 'file',
  size: 120,
  openable: true,
  agent,
  skill: null,
  workflow: null,
});

const ENTRIES = [
  entry('README.md'),
  entry(AGENT_PATH, 'reviewer'),
  entry('agents/reviewer/run.sh', 'reviewer'),
];

const text = (path: string, content: string, commit = SHA): AgentFileOutput => ({
  commit,
  path,
  kind: 'text',
  content,
});

const CONTENTS: Record<string, AgentFileOutput> = {
  [AGENT_PATH]: text(AGENT_PATH, AGENT_MD),
  'agents/reviewer/run.sh': text('agents/reviewer/run.sh', 'echo hi'),
  'README.md': text('README.md', '# Readme'),
};

const MODIFIED: Partial<AgentDraftOutput> = {
  baseCommit: SHA,
  currentCommit: SHA,
  version: 3,
  files: [
    {
      path: 'agents/reviewer/run.sh',
      change: 'modified',
      size: 7,
      movedFrom: null,
      skill: null,
      workflow: null,
    },
    {
      path: 'agents/reviewer/notes.md',
      change: 'added',
      size: 3,
      movedFrom: null,
      skill: null,
      workflow: null,
    },
    {
      path: 'agents/reviewer/old.txt',
      change: 'deleted',
      size: 0,
      movedFrom: null,
      skill: null,
      workflow: null,
    },
  ],
};

function setup(options: { draft?: Partial<AgentDraftOutput>; path?: string } = {}) {
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
      <AgentEditor />
    </QueryClientProvider>,
  );
  return { api, client, ...view };
}

const publishButton = () => screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;
const publishes = (api: ReturnType<typeof fakeAgentsApi>) =>
  api.calls().filter((call) => call.method === 'POST' && call.path === PUBLISH_URL);

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('navigation', { name: 'Files' });
  await user.click(publishButton());
  return screen.findByRole('dialog');
}

async function submit(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  message = 'Add notes',
) {
  await user.type(within(dialog).getByLabelText('Commit message'), message);
  await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('publishMessageError', () => {
  it('mirrors the API: 1 to 2,000 characters, no NUL, a subject on the first line', () => {
    expect(publishMessageError('Fix it')).toBeUndefined();
    expect(publishMessageError('Subject\n\nBody')).toBeUndefined();
    expect(publishMessageError('a'.repeat(2000))).toBeUndefined();
    expect(publishMessageError('')).toMatch(/1 to 2,000/);
    expect(publishMessageError('a'.repeat(2001))).toMatch(/1 to 2,000/);
    expect(publishMessageError('a\0b')).toMatch(/NUL/);
    expect(publishMessageError('  \nbody')).toMatch(/subject/);
  });
});

describe('Publish: the button', () => {
  it('is disabled with the reason while the Draft has no changes', async () => {
    const { container } = setup();
    await screen.findByRole('navigation', { name: 'Files' });
    expect(publishButton().disabled).toBe(true);
    expect(screen.getByText('The Draft has no changes to publish.')).toBeTruthy();
    await expect(container).toHaveNoAxeViolations();
  });

  it('is offered when the Draft has changes, no problems and no unsaved edits', async () => {
    setup({ draft: MODIFIED });
    await screen.findByRole('navigation', { name: 'Files' });
    expect(publishButton().disabled).toBe(false);
  });

  it('is disabled with the reason while an edit is unsaved', async () => {
    setup({ draft: MODIFIED, path: undefined });
    const user = userEvent.setup();
    await screen.findByRole('navigation', { name: 'Files' });
    await user.click(
      within(screen.getByRole('navigation', { name: 'Files' })).getByText('README.md'),
    );
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByRole('textbox', { name: /^File / });
    fireEvent.change(editor, { target: { value: 'edited' } });

    expect(publishButton().disabled).toBe(true);
    expect(screen.getByText('Save or discard your unsaved edits first.')).toBeTruthy();
  });

  it('is disabled with the reason while a changed agent has a problem', async () => {
    setup({
      draft: {
        ...MODIFIED,
        problems: [
          {
            agent: 'reviewer',
            code: 'provider_unknown',
            path: AGENT_PATH,
            key: 'provider',
            message: 'The provider is not one Studio knows.',
          },
        ],
      },
    });
    await screen.findByRole('navigation', { name: 'Files' });
    expect(publishButton().disabled).toBe(true);
    expect(screen.getByText('Fix the 1 problem of the Draft first.')).toBeTruthy();
  });

  it('is disabled with the reason while the Repository has moved past the Draft', async () => {
    setup({ draft: { ...MODIFIED, currentCommit: NEW_SHA } });
    await screen.findByRole('navigation', { name: 'Files' });
    expect(publishButton().disabled).toBe(true);
    expect(
      screen.getByText(/moved since the Draft began, so the Draft cannot be published\./),
    ).toBeTruthy();
  });
});

describe('Publish: the dialog', () => {
  it('shows the changes with their marks and asks for a commit message, without axe violations', async () => {
    setup({ draft: MODIFIED });
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    const list = within(dialog).getByRole('navigation', { name: 'Changed files' });
    expect(within(list).getByText('Modified')).toBeTruthy();
    expect(within(list).getByText('Added')).toBeTruthy();
    expect(within(list).getByText('Deleted')).toBeTruthy();
    expect(await within(dialog).findByTestId('diff')).toBeTruthy();
    expect(within(dialog).getByLabelText('Commit message')).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('validates the message like the API and sends nothing while it is wrong', async () => {
    const { api } = setup({ draft: MODIFIED });
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByText(/1 to 2,000 characters/)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
    fireEvent.change(within(dialog).getByLabelText('Commit message'), {
      target: { value: '\nonly a body' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByText(/write one/)).toBeTruthy();
    expect(publishes(api)).toEqual([]);
  });

  it('sends the message with the base commit and version the page showed', async () => {
    const { api } = setup({ draft: MODIFIED });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await submit(user, dialog, 'Add notes\n\nWhy');
    await waitFor(() => expect(publishes(api)).toHaveLength(1));
    expect(publishes(api)[0]?.body).toEqual({
      message: 'Add notes\n\nWhy',
      baseCommit: SHA,
      version: 3,
    });
  });

  it('sends one publish for a double click and keeps the button busy', async () => {
    const { api } = setup({ draft: MODIFIED });
    const release = api.hold('publish');
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText('Commit message'), 'Add notes');
    const button = within(dialog).getByRole('button', { name: 'Publish' });
    await user.dblClick(button);

    await waitFor(() => expect(publishes(api)).toHaveLength(1));
    expect(
      (within(dialog).getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    act(() => release());
    await within(dialog).findByText(/Published as commit/);
    expect(publishes(api)).toHaveLength(1);
  });

  it('shows the new commit, an empty Draft and the tree at the new commit after success', async () => {
    const { api } = setup({ draft: MODIFIED });
    api.willPublish(NEW_SHA, {
      files: {
        tree: { commit: NEW_SHA, repository: REPOSITORY, truncated: false, entries: ENTRIES },
        contents: CONTENTS,
      },
      list: agentList({
        commit: NEW_SHA,
        repository: REPOSITORY,
        agents: [...BUILT_INS, GOOD],
      }),
    });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await submit(user, dialog);

    const done = await within(dialog).findByText(/Published as commit/);
    expect(done.textContent).toContain(NEW_SHA.slice(0, 7));
    await expect(dialog).toHaveNoAxeViolations();
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(await screen.findByText(NEW_SHA.slice(0, 7), { selector: 'code' })).toBeTruthy();
    await screen.findByRole('button', { name: 'Changes (0)' });
    expect(publishButton().disabled).toBe(true);
    expect(screen.queryByText(/Draft based on commit/)).toBeNull();
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    const reads = api.calls().filter((call) => call.method === 'GET');
    expect(
      reads.filter((call) => call.path.endsWith('/definitions-repository/files')),
    ).toHaveLength(2);
    expect(reads.filter((call) => call.path === '/api/agents')).not.toHaveLength(1);
  });
});

const fail = (status: number, type: string, extras: Record<string, unknown> = {}) => ({
  ...problem(status, 'Refused', { type: `urn:agentic-studio:problem:${type}` }),
  ...extras,
});

describe('Publish: each refusal has its own message', () => {
  async function refused(status: number, body: unknown, draft = MODIFIED) {
    const { api, ...rest } = setup({ draft });
    api.failNextDraftWrite(status, body);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await submit(user, dialog);
    return { api, user, dialog, ...rest };
  }

  it('write-refused says to give the Deploy key write access on the Git host', async () => {
    const { dialog } = await refused(409, fail(409, 'write-refused'));
    const message = await within(dialog).findByText(/Deploy key/);
    expect(message.textContent).toMatch(/write access/);
    expect(message.textContent).toMatch(/Git host/);
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('publish-not-configured names the two server settings', async () => {
    const { dialog } = await refused(503, fail(503, 'publish-not-configured'));
    const message = await within(dialog).findByText(/STUDIO_DEFINITIONS_COMMIT_NAME/);
    expect(message.textContent).toContain('STUDIO_DEFINITIONS_COMMIT_EMAIL');
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('publish-problems lists the problems', async () => {
    const { dialog } = await refused(
      422,
      fail(422, 'publish-problems', {
        problems: [
          {
            agent: 'reviewer',
            code: 'description_missing',
            path: AGENT_PATH,
            key: 'description',
            message: 'The description is missing.',
          },
        ],
      }),
    );
    const list = await within(dialog).findByRole('list', { name: 'Problems of the Draft' });
    expect(within(list).getByText(/The description is missing\./)).toBeTruthy();
    expect(within(list).getByText(AGENT_PATH)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('publish-problems lists the problems of a workflow beside the others', async () => {
    const { dialog } = await refused(
      422,
      fail(422, 'publish-problems', {
        problems: [],
        skillProblems: [],
        workflowProblems: [
          {
            workflow: 'ship',
            code: 'phase_agent_missing',
            path: 'workflows/ship/WORKFLOW.md',
            key: 'ghost',
            message: 'The phase "build" names the agent "ghost", which does not exist.',
          },
        ],
      }),
    );
    const list = await within(dialog).findByRole('list', { name: 'Problems of the Draft' });
    expect(within(list).getByText(/which does not exist./)).toBeTruthy();
    expect(within(list).getByText('workflows/ship/WORKFLOW.md')).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('draft-not-judged says the Draft is too large to be checked', async () => {
    const { dialog } = await refused(503, fail(503, 'draft-not-judged', {}));
    const message = await within(dialog).findByText(/Split the changes into smaller Drafts/);
    expect(message.textContent).toContain('cannot tell whether it is valid');
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('publish-problems lists the problems of skills beside those of agents', async () => {
    const { dialog } = await refused(
      422,
      fail(422, 'publish-problems', {
        problems: [],
        skillProblems: [
          {
            skill: 'lint',
            code: 'forbidden_key',
            path: 'skills/lint/SKILL.md',
            key: 'tools',
            message: 'The key "tools" is not allowed.',
          },
        ],
      }),
    );
    const list = await within(dialog).findByRole('list', { name: 'Problems of the Draft' });
    expect(within(list).getByText(/is not allowed/)).toBeTruthy();
    expect(within(list).getByText('skills/lint/SKILL.md')).toBeTruthy();
  });

  it('publish-path-outside-definitions lists the paths and reverts them on request', async () => {
    const { api, user, dialog } = await refused(
      422,
      fail(422, 'publish-path-outside-definitions', { paths: ['README.md', 'config.json'] }),
      {
        ...MODIFIED,
        files: [
          ...(MODIFIED.files ?? []),
          {
            path: 'README.md',
            change: 'modified',
            size: 3,
            movedFrom: null,
            skill: null,
            workflow: null,
          },
          {
            path: 'config.json',
            change: 'added',
            size: 3,
            movedFrom: null,
            skill: null,
            workflow: null,
          },
        ],
      },
    );
    const list = await within(dialog).findByRole('list', {
      name: 'Paths outside agents/, skills/ and workflows/',
    });
    expect(within(list).getByText('README.md')).toBeTruthy();
    expect(within(list).getByText('config.json')).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();

    await user.click(within(dialog).getByRole('button', { name: 'Revert these files' }));
    await waitFor(() =>
      expect(
        api
          .calls()
          .filter((call) => call.path.endsWith('/draft/files/revert'))
          .map((call) => call.body),
      ).toEqual([{ path: 'README.md' }, { path: 'config.json' }]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a conflict offers to reload the Draft', async () => {
    const { user, dialog } = await refused(409, fail(409, 'agent-draft-conflict'));
    await within(dialog).findByText(/Another change to the Draft landed/);
    await expect(dialog).toHaveNoAxeViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Reload the Draft' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('repository-moved says the Draft cannot be published again and offers to discard it', async () => {
    const { user, dialog } = await refused(409, fail(409, 'repository-moved'));
    const message = await within(dialog).findByText(/cannot be published again/);
    expect(message.textContent).toMatch(/already/);
    await expect(dialog).toHaveNoAxeViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Discard the Draft' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Discard the Draft', { selector: 'h2' })).toBeTruthy();
  });

  it('publish-failed says the push may have reached the Git host', async () => {
    const { dialog } = await refused(502, fail(502, 'publish-failed'));
    const message = await within(dialog).findByText(/may still have reached the Git host/);
    expect(message.textContent).toMatch(/next publish/);
    await expect(dialog).toHaveNoAxeViolations();
  });

  it.each([
    [409, 'publish-running', /Another publish is running/],
    [409, 'nothing-to-publish', /changes nothing/],
    [503, 'agent-files-unreadable', /cannot be read/],
    [409, 'agent-draft-base-missing', /no longer in the Repository/],
    [409, 'agent-draft-no-base', /no fetched commit/],
    [500, 'unknown-server-failure', /may still have gone through/],
  ] as const)(
    '%s %s says what happened',
    async (status, type, pattern) => {
      const { dialog } = await refused(status, fail(status, type));
      expect(await within(dialog).findByText(pattern)).toBeTruthy();
    },
    15000,
  );

  it('keeps the dialog open and the message after a refusal, so a retry needs no retyping', async () => {
    const { api, user, dialog } = await refused(409, fail(409, 'publish-running'));
    await within(dialog).findByText(/Another publish is running/);
    expect((within(dialog).getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe(
      'Add notes',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await within(dialog).findByText(/Published as commit/);
    expect(publishes(api)).toHaveLength(2);
  });

  it('shows the reason of a refused message for a 400', async () => {
    const { dialog } = await refused(
      400,
      fail(400, 'validation', { errors: [{ path: 'message', message: 'Too long for the host.' }] }),
    );
    expect(await within(dialog).findByText('Too long for the host.')).toBeTruthy();
  });

  it('says so when reverting the paths outside agents/, skills/ and workflows/ is refused, and stays open', async () => {
    const { api, user, dialog } = await refused(
      422,
      fail(422, 'publish-path-outside-definitions', { paths: ['README.md'] }),
    );
    await within(dialog).findByRole('list', {
      name: 'Paths outside agents/, skills/ and workflows/',
    });
    api.failNextDraftWrite(500, problem(500, 'Broken'));
    await user.click(within(dialog).getByRole('button', { name: 'Revert these files' }));
    expect(await within(dialog).findByText(/Broken \(test\)/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('treats a network error like a failed push and offers to reload the Draft', async () => {
    const { api } = setup({ draft: MODIFIED });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (request: Request) =>
      request.url.endsWith('/draft/publish')
        ? Promise.reject(new TypeError('network down'))
        : real(request),
    );
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await submit(user, dialog);
    await within(dialog).findByText(/may still have gone through/);
    expect(within(dialog).getByRole('button', { name: 'Reload the Draft' })).toBeTruthy();
    await waitFor(() =>
      expect(
        api
          .calls()
          .filter(
            (call) => call.method === 'GET' && call.path.endsWith('/definitions-repository/files'),
          ),
      ).toHaveLength(2),
    );
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('reads the Draft and the tree again after an answer the API has no name for', async () => {
    const { api, dialog } = await refused(500, fail(500, 'unknown-server-failure'));
    await within(dialog).findByText(/may still have gone through/);
    await waitFor(() =>
      expect(
        api
          .calls()
          .filter(
            (call) => call.method === 'GET' && call.path.endsWith('/definitions-repository/files'),
          ),
      ).toHaveLength(2),
    );
  });
});

describe('Publish: a Draft kept through the publish', () => {
  it('says the commit was published but the saved changes cannot be, and offers to discard', async () => {
    const { api } = setup({ draft: MODIFIED });
    api.willPublish(NEW_SHA, {
      draft: {
        baseCommit: SHA,
        version: 9,
        files: [
          {
            path: 'agents/reviewer/late.md',
            change: 'added',
            size: 3,
            movedFrom: null,
            skill: null,
            workflow: null,
          },
        ],
      },
    });
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await submit(user, dialog);

    const status = await within(dialog).findByText(/Published as commit/);
    expect(status.textContent).not.toMatch(/Draft is empty/);
    expect(
      await within(dialog).findByText(/saved to the Draft while it was being published/),
    ).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Discard the Draft' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('says the Draft is empty only when it is, and moves focus to the result', async () => {
    const { api } = setup({ draft: MODIFIED });
    api.willPublish(NEW_SHA);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await submit(user, dialog);
    const status = await within(dialog).findByText(/The Draft is empty/);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(status.closest('[tabindex="-1"]')).toBe(document.activeElement);
  });
});
