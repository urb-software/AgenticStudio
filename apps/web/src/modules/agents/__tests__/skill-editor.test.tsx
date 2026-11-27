import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSkillFolder } from '@agentic-studio/agent-definitions';
import { AgentEditor } from '..';
import type {
  AgentDraftOutput,
  AgentFileEntryOutput,
  AgentFileOutput,
  AgentSummaryOutput,
  SkillListOutput,
  SkillSummaryOutput,
} from '../../../platform/api';
import { agentList, BUILT_INS, fakeAgentsApi } from './fake-agents-api';
import { skillList } from './fake-skills-api';

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
const SKILL_MD = '---\nname: lint\ndescription: Lints a change\n---\nSteps.\n';
const AGENT_MD =
  '---\nname: reviewer\ndescription: Reviews a change\nprovider: claude_code\nskills:\n  - lint\n---\nHi';
const SKILL_PATH = 'skills/lint/SKILL.md';

const REVIEWER: AgentSummaryOutput = {
  name: 'reviewer',
  description: 'Reviews a change',
  provider: 'claude_code',
  model: 'default',
  source: 'definitions',
  usable: true,
  skills: ['lint'],
  problems: [],
};
const LINT: SkillSummaryOutput = {
  name: 'lint',
  description: 'Lints a change',
  valid: true,
  problems: [],
};
const ROTTEN: SkillSummaryOutput = {
  name: 'rotten',
  description: null,
  valid: false,
  problems: [
    {
      code: 'front_matter_missing',
      path: 'SKILL.md',
      key: null,
      message: 'The file has no front matter.',
    },
  ],
};

const entry = (
  path: string,
  owner: { agent?: string; skill?: string } = {},
): AgentFileEntryOutput => ({
  path,
  kind: 'file',
  size: 120,
  openable: true,
  agent: owner.agent ?? null,
  skill: owner.skill ?? null,
  workflow: null,
});

const ENTRIES = [
  entry('agents/reviewer/AGENT.md', { agent: 'reviewer' }),
  entry(SKILL_PATH, { skill: 'lint' }),
  entry('skills/rotten/SKILL.md', { skill: 'rotten' }),
];

const text = (path: string, content: string): AgentFileOutput => ({
  commit: SHA,
  path,
  kind: 'text',
  content,
});

const CONTENTS: Record<string, AgentFileOutput> = {
  'agents/reviewer/AGENT.md': text('agents/reviewer/AGENT.md', AGENT_MD),
  [SKILL_PATH]: text(SKILL_PATH, SKILL_MD),
  'skills/rotten/SKILL.md': text('skills/rotten/SKILL.md', 'no front matter'),
};

function setup(
  options: {
    path?: string;
    query?: string;
    draft?: Partial<AgentDraftOutput>;
    entries?: AgentFileEntryOutput[];
    contents?: Record<string, AgentFileOutput>;
    skills?: Partial<SkillListOutput>;
  } = {},
) {
  search = options.query ?? (options.path ? `path=${encodeURIComponent(options.path)}` : '');
  const api = fakeAgentsApi(
    { repository: null },
    {
      list: agentList({
        commit: SHA,
        repository: REPOSITORY,
        agents: [...BUILT_INS, REVIEWER],
      }),
      files: {
        tree: {
          commit: SHA,
          repository: REPOSITORY,
          truncated: false,
          entries: options.entries ?? ENTRIES,
        },
        contents: options.contents ?? CONTENTS,
      },
      skills: skillList({ commit: SHA, skills: [LINT, ROTTEN], ...options.skills }),
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

const TOUCHED_DRAFT: Partial<AgentDraftOutput> = {
  baseCommit: SHA,
  currentCommit: SHA,
  version: 2,
  files: [
    {
      path: SKILL_PATH,
      change: 'modified',
      size: 80,
      movedFrom: null,
      skill: 'lint',
      workflow: null,
    },
  ],
};

const treeNav = () => screen.getByRole('navigation', { name: 'Files' });
const publish = () => screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement;

beforeEach(() => {
  replace.mockClear();
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => focusManager.setFocused(undefined));
  window.sessionStorage.clear();
});

describe('skills in the editor: the tree and the problems', () => {
  it('marks the skill folders with their validation state', async () => {
    setup({ path: SKILL_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    const skills = within(treeNav()).getByRole('button', { name: /^skills/ });
    expect(skills.getAttribute('aria-expanded')).toBe('true');
    const lint = within(treeNav()).getByRole('button', { name: /^lint/ });
    expect(within(lint).getByText('Valid')).toBeTruthy();
    await user.click(within(treeNav()).getByRole('button', { name: /^rotten/ }));
    const rotten = within(treeNav()).getByRole('button', { name: /^rotten/ });
    expect(within(rotten).getByText('1 problem')).toBeTruthy();
  });

  it('lists the problems of the Draft’s skills, goes to the file, and keeps Publish off', async () => {
    setup({
      path: 'agents/reviewer/AGENT.md',
      draft: {
        ...TOUCHED_DRAFT,
        skillProblems: [
          {
            skill: 'lint',
            code: 'forbidden_key',
            path: SKILL_PATH,
            key: 'tools',
            message: 'The key "tools" is not allowed.',
          },
        ],
      },
    });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(publish().disabled).toBe(true);
    expect(screen.getByText('Fix the 1 problem of the Draft first.')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: /is not allowed/ }));

    await waitFor(() => expect(screen.getByTestId('monaco').dataset.path).toBe(SKILL_PATH));
  });

  it('shows an agent the Draft does not change by name, because it names a skill the Draft changes', async () => {
    setup({
      draft: {
        ...TOUCHED_DRAFT,
        problems: [
          {
            agent: 'reviewer',
            code: 'skill_invalid',
            path: 'agents/reviewer/AGENT.md',
            key: 'lint',
            message: 'The skill "lint" is not valid.',
          },
        ],
      },
    });
    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(within(list).getByText('agents/reviewer/AGENT.md')).toBeTruthy();
    expect(within(list).getByText(/names a skill the Draft changes/)).toBeTruthy();
    expect(publish().disabled).toBe(true);
  });

  it('keeps the API’s problem of a skill file the browser does not hold while the skill is open', async () => {
    setup({
      path: SKILL_PATH,
      draft: {
        ...TOUCHED_DRAFT,
        skillProblems: [
          {
            skill: 'lint',
            code: 'shell_line',
            path: 'skills/lint/notes.md',
            key: null,
            message: 'The file has a shell line.',
          },
        ],
      },
    });
    await screen.findByTestId('monaco');

    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(within(list).getByText('skills/lint/notes.md')).toBeTruthy();
    expect(publish().disabled).toBe(true);
    const lint = within(treeNav()).getByRole('button', { name: /^lint/ });
    expect(within(lint).getByText('1 problem')).toBeTruthy();
  });

  it('keeps the API’s skill check of an agent for a skill the cut list does not hold', async () => {
    const agentText = AGENT_MD.replace('  - lint', '  - far');
    setup({
      path: 'agents/reviewer/AGENT.md',
      entries: [...ENTRIES, entry('skills/far/SKILL.md', { skill: 'far' })],
      contents: {
        ...CONTENTS,
        'agents/reviewer/AGENT.md': text('agents/reviewer/AGENT.md', agentText),
      },
      skills: { truncated: true },
      draft: {
        baseCommit: SHA,
        currentCommit: SHA,
        version: 2,
        files: [
          {
            path: 'agents/reviewer/AGENT.md',
            change: 'modified',
            size: 90,
            movedFrom: null,
            skill: null,
            workflow: null,
          },
        ],
        problems: [
          {
            agent: 'reviewer',
            code: 'skill_invalid',
            path: 'agents/reviewer/AGENT.md',
            key: 'far',
            message: 'The skill "far" is not valid.',
          },
        ],
      },
    });
    await screen.findByTestId('monaco');

    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(within(list).getAllByText(/is not valid/)).toHaveLength(1);
    expect(publish().disabled).toBe(true);
    expect(screen.getByText('Fix the 1 problem of the Draft first.')).toBeTruthy();
  });

  it('counts and lists once an agent the API judged that the editor’s lists do not hold', async () => {
    setup({
      draft: {
        ...TOUCHED_DRAFT,
        problems: [
          {
            agent: 'ghost',
            code: 'skill_invalid',
            path: 'agents/ghost/AGENT.md',
            key: 'lint',
            message: 'The skill "lint" is not valid.',
          },
        ],
      },
    });

    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(within(list).getAllByText('agents/ghost/AGENT.md')).toHaveLength(1);
    expect(publish().disabled).toBe(true);
    expect(screen.getByText('Fix the 1 problem of the Draft first.')).toBeTruthy();
  });

  it('shows no state for a skill folder the Draft has emptied', async () => {
    setup({
      path: 'skills/rotten/SKILL.md',
      draft: {
        baseCommit: SHA,
        currentCommit: SHA,
        version: 2,
        files: [
          {
            path: SKILL_PATH,
            change: 'deleted',
            size: 0,
            movedFrom: null,
            skill: 'lint',
            workflow: null,
          },
        ],
      },
    });
    await screen.findByTestId('monaco');

    const lint = within(treeNav()).getByRole('button', { name: /^lint/ });
    expect(within(lint).queryByText('Valid')).toBeNull();
    expect(within(lint).queryByText(/problem/)).toBeNull();
  });

  it('says a Draft that was not judged cannot be published, with the reason', async () => {
    setup({
      path: SKILL_PATH,
      draft: { ...TOUCHED_DRAFT, judged: false, notJudgedReason: 'over_limits' },
    });
    await screen.findByTestId('monaco');

    expect(publish().disabled).toBe(true);
    expect((await screen.findAllByText(/Split the changes into smaller Drafts/)).length).toBe(2);
    expect(screen.getByText('The Draft was not checked')).toBeTruthy();
    await expect(document.body).toHaveNoAxeViolations();
  });

  it('says so when the Clone could not be read to check the Draft', async () => {
    setup({
      path: SKILL_PATH,
      draft: { ...TOUCHED_DRAFT, judged: false, notJudgedReason: 'clone_unreadable' },
    });
    await screen.findByTestId('monaco');

    expect(publish().disabled).toBe(true);
    expect((await screen.findAllByText(/could not be checked now/)).length).toBe(2);
    await expect(document.body).toHaveNoAxeViolations();
  });
});

describe('skills in the editor: validation while typing', () => {
  it('flags a forbidden key in the open skill and the agent that names it', async () => {
    setup({ path: SKILL_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = (await screen.findByRole('textbox', { name: /^File / })) as HTMLTextAreaElement;

    fireEvent.change(editor, {
      target: { value: '---\nname: lint\ndescription: Lints\ntools: Bash\n---\nSteps.\n' },
    });

    await waitFor(() => {
      const markers = JSON.parse(screen.getByTestId('monaco').dataset.markers ?? '[]') as {
        message: string;
      }[];
      expect(markers.some((marker) => /tools/.test(marker.message))).toBe(true);
    });
    const list = await screen.findByRole('region', { name: 'Problems' });
    expect(within(list).getByText('agents/reviewer/AGENT.md')).toBeTruthy();
    expect(within(list).getByText(/names a skill the Draft changes/)).toBeTruthy();
    const lint = within(treeNav()).getByRole('button', { name: /^lint/ });
    expect(within(lint).getByText('1 problem')).toBeTruthy();
  });

  it('flags an open agent that names a skill missing from the Draft state', async () => {
    setup({
      path: 'agents/reviewer/AGENT.md',
      draft: {
        baseCommit: SHA,
        currentCommit: SHA,
        version: 2,
        files: [
          {
            path: SKILL_PATH,
            change: 'deleted',
            size: 0,
            movedFrom: null,
            skill: 'lint',
            workflow: null,
          },
          {
            path: 'agents/reviewer/AGENT.md',
            change: 'modified',
            size: 90,
            movedFrom: null,
            skill: null,
            workflow: null,
          },
        ],
      },
    });
    await screen.findByTestId('monaco');

    const list = await screen.findByRole('region', { name: 'Problems' });
    await waitFor(() => expect(within(list).getByText(/lint/)).toBeTruthy());
    expect(within(list).getByText('agents/reviewer/AGENT.md')).toBeTruthy();
  });
});

describe('skills in the editor: New skill', () => {
  it('creates skills/<name>/SKILL.md from a template that passes the validation', async () => {
    const { api } = setup({ path: SKILL_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = await screen.findByRole('dialog', { name: 'New skill' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'fresh');
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }));

    await waitFor(() => {
      const put = api.calls().find((call) => call.method === 'PUT');
      expect(put?.body).toMatchObject({ path: 'skills/fresh/SKILL.md' });
      const body = put?.body as { text: string };
      const judged = validateSkillFolder('fresh', [
        { path: 'SKILL.md', kind: 'file', size: body.text.length, content: body.text },
      ]);
      expect(judged.ok).toBe(true);
    });
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/agents/editor?path=skills%2Ffresh%2FSKILL.md', {
        scroll: false,
      }),
    );
  });

  it('refuses a name that is taken or not a name', async () => {
    setup({ path: SKILL_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = await screen.findByRole('dialog', { name: 'New skill' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.type(name, 'lint');
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    expect(await within(dialog).findByText(/already exists/)).toBeTruthy();
    await user.clear(name);
    await user.type(name, 'Bad Name');
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    expect(await within(dialog).findByText(/lower-case letters/)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('drops ?new=skill from the address when the step is cancelled', async () => {
    setup({ query: 'new=skill' });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New skill' });

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/agents/editor', { scroll: false }));
  });

  it('lets a skill the Draft deletes be made again', async () => {
    const { api } = setup({
      path: SKILL_PATH,
      draft: {
        baseCommit: SHA,
        currentCommit: SHA,
        version: 2,
        files: [
          {
            path: 'skills/rotten/SKILL.md',
            change: 'deleted',
            size: 0,
            movedFrom: null,
            skill: 'rotten',
            workflow: null,
          },
        ],
      },
    });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = await screen.findByRole('dialog', { name: 'New skill' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'rotten');
    await user.click(within(dialog).getByRole('button', { name: 'Create skill' }));

    await waitFor(() =>
      expect(api.calls().find((call) => call.method === 'PUT')?.body).toMatchObject({
        path: 'skills/rotten/SKILL.md',
      }),
    );
  });

  it('opens on the New skill step when the Skills view sends the operator here', async () => {
    setup({ query: 'new=skill' });

    expect(await screen.findByRole('dialog', { name: 'New skill' })).toBeTruthy();
  });

  it('takes a new file path under skills/<name>/ as it does one under agents/', async () => {
    const { api } = setup({ path: SKILL_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'New file' }));
    const dialog = await screen.findByRole('dialog');
    const path = within(dialog).getByRole('textbox', { name: /path/i });
    await user.clear(path);
    await user.type(path, 'skills/lint/scripts/run.sh');
    await user.click(within(dialog).getByRole('button', { name: /^(Add|Create)/ }));

    await waitFor(() =>
      expect(api.calls().find((call) => call.method === 'PUT')?.body).toMatchObject({
        path: 'skills/lint/scripts/run.sh',
      }),
    );
  });
});

describe('skills in the editor: deleting or renaming a skill', () => {
  it('shows the agents that name the skill before deleting its entry file', async () => {
    setup({ path: SKILL_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText(/would become invalid: reviewer\./)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('shows them before renaming the entry file', async () => {
    setup({ path: SKILL_PATH });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/would become invalid: reviewer\./)).toBeTruthy();
    await expect(dialog).toHaveNoAxeViolations();
  });

  it('shows no warning for a skill no agent names', async () => {
    setup({ path: 'skills/rotten/SKILL.md' });
    const user = userEvent.setup();
    await screen.findByTestId('monaco');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).queryByText(/would become invalid/)).toBeNull();
  });
});
