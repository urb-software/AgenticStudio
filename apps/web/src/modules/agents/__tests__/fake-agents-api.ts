import { vi } from 'vitest';
import type {
  AgentDetailOutput,
  AgentDraftFileOutput,
  AgentDraftOutput,
  AgentFileOutput,
  AgentFilesOutput,
  AgentListOutput,
  AgentSummaryOutput,
  ProblemDetails,
  ProviderAvailabilityOutput,
  ProjectOutput,
  RepositoryOutput,
} from '../../../platform/api';

/** What `GET /api/providers` answers: each Provider with the models an agent may name. */
export const PROVIDERS: ProviderAvailabilityOutput[] = [
  {
    id: 'claude_code',
    name: 'Claude Code',
    available: true,
    models: ['default', 'opus', 'sonnet', 'haiku'],
  },
  {
    id: 'codex',
    name: 'Codex',
    available: false,
    reason: 'Switched off on the agent worker.',
    models: ['default', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-luna'],
  },
];

export const BASE_RULES = { version: '2026-11-1', text: 'Base rules, line one.\nLine two.' };

export const BUILT_INS: AgentSummaryOutput[] = ['default-claude-code', 'default-codex'].map(
  (name) => ({
    name,
    description: `The ${name} agent`,
    provider: name === 'default-codex' ? 'codex' : 'claude_code',
    model: 'default',
    source: 'built_in',
    usable: true,
    skills: [],
    problems: [],
  }),
);

export function agentList(overrides: Partial<AgentListOutput> = {}): AgentListOutput {
  return {
    commit: null,
    repository: null,
    truncated: false,
    baseRules: BASE_RULES,
    agents: BUILT_INS,
    ...overrides,
  };
}

export function agentDetail(
  agent: AgentSummaryOutput,
  extras: { instructions?: string; files?: { path: string; size: number }[] } = {},
  overrides: Partial<AgentDetailOutput> = {},
): AgentDetailOutput {
  return {
    commit: null,
    repository: null,
    agent: { ...agent, instructions: extras.instructions ?? '', files: extras.files ?? [] },
    ...overrides,
  };
}

export const DEFINITIONS_PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000d1',
  name: 'Agent definitions',
  mergeMethod: 'squash',
  kind: 'definitions',
  defaultAgent: null,
  createdAt: '2026-11-12T09:00:00.000Z',
};

export function problem(status: number, title: string, extras: Partial<ProblemDetails> = {}) {
  return {
    type: 'about:blank',
    title,
    status,
    detail: `${title} (test)`,
    correlationId: '00000000-0000-4000-8000-000000000000',
    ...extras,
  } satisfies ProblemDetails;
}

const REPOSITORY = /^\/api\/projects\/([^/]+)\/repository(\/fetch)?$/;

/**
 * The Agents page's API behind `fetch`: the definitions Repository read, the Project create and
 * the Project with its Repository (read, connect, fetch). `initial` is the server's state: no
 * Project (`null`), or the Project with its Repository (`null` until connected).
 */
export function fakeAgentsApi(
  initial: { repository: RepositoryOutput | null } | null,
  agents: {
    list?: AgentListOutput;
    details?: Record<string, AgentDetailOutput>;
    /** The definitions Repository's files: the tree and each file's content by path. */
    files?: { tree: AgentFilesOutput; contents?: Record<string, AgentFileOutput> };
    /** The Draft the server starts with. */
    draft?: Partial<AgentDraftOutput>;
  } = {},
) {
  let list = agents.list ?? agentList();
  const details = { ...agents.details };
  let files = agents.files;
  let project: ProjectOutput | null = initial ? DEFINITIONS_PROJECT : null;
  let repository: RepositoryOutput | null = initial?.repository ?? null;
  const calls: { method: string; path: string; search: string; body?: unknown }[] = [];
  const scripted: { status: number; body: unknown }[] = [];
  const listFailures: { status: number; body: unknown }[] = [];
  const detailFailures: { status: number; body: unknown }[] = [];
  const providerFailures: { status: number; body: unknown }[] = [];
  const gates: { list?: Promise<void>; detail?: Promise<void>; publish?: Promise<void> } = {};
  let published:
    | {
        commit: string;
        files?: { tree: AgentFilesOutput; contents?: Record<string, AgentFileOutput> };
        list?: AgentListOutput;
        draft?: Partial<AgentDraftOutput>;
      }
    | undefined;
  let draft: AgentDraftOutput = {
    baseCommit: null,
    currentCommit: agents.files?.tree.commit ?? null,
    version: 0,
    files: [],
    problems: [],
    skillProblems: [],
    judged: true,
    notJudgedReason: null,
    movedUpstream: [],
    ...agents.draft,
  };
  const draftTexts = new Map<string, string>();
  const draftFailures: { status: number; body: unknown }[] = [];
  const inTree = (path: string) => files?.tree.entries.some((item) => item.path === path) ?? false;
  const touch = (next: Partial<AgentDraftOutput>) => {
    draft = { ...draft, ...next, version: draft.version + 1 };
    if (draft.files.length === 0) draft = { ...draft, baseCommit: null };
    return draft;
  };
  const upsert = (file: AgentDraftFileOutput) =>
    touch({
      baseCommit: draft.baseCommit ?? files?.tree.commit ?? null,
      files: [...draft.files.filter((item) => item.path !== file.path), file],
    });

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname, search } = new URL(request.url);
    // A body-less POST (the fetch command) has no JSON to read.
    const text = request.method === 'POST' || request.method === 'PUT' ? await request.text() : '';
    const body: unknown = text ? JSON.parse(text) : undefined;
    calls.push({ method: request.method, path: pathname, search, body });
    if (pathname === '/api/providers' && request.method === 'GET') {
      const failure = providerFailures.shift();
      return failure ? json(failure.status, failure.body) : json(200, PROVIDERS);
    }
    const response = request.method === 'GET' ? scripted.shift() : undefined;
    if (response) return json(response.status, response.body);

    if (pathname === '/api/agents' && request.method === 'GET') {
      await gates.list;
      const failure = listFailures.shift();
      return failure ? json(failure.status, failure.body) : json(200, list);
    }
    const detail = /^\/api\/agents\/([^/]+)$/.exec(pathname);
    if (detail && detail[1] !== 'definitions-repository') {
      await gates.detail;
      const failure = detailFailures.shift();
      if (failure) return json(failure.status, failure.body);
      const found = details[decodeURIComponent(detail[1] ?? '')];
      return found ? json(200, found) : json(404, problem(404, 'Unknown agent'));
    }
    if (pathname.startsWith('/api/agents/definitions-repository/draft')) {
      const search_ = new URL(request.url).searchParams;
      const draftPath = pathname.slice('/api/agents/definitions-repository/draft'.length);
      if (request.method !== 'GET') {
        const failure = draftFailures.shift();
        if (failure) return json(failure.status, failure.body);
      }
      if (draftPath === '' && request.method === 'GET') return json(200, draft);
      if (draftPath === '' && request.method === 'DELETE') {
        draftTexts.clear();
        return json(200, touch({ files: [], problems: [], skillProblems: [], movedUpstream: [] }));
      }
      if (draftPath === '/files/content') {
        const path = search_.get('path') ?? '';
        const changed = draft.files.find((item) => item.path === path);
        if (changed?.change === 'deleted') return json(404, problem(404, 'No such file'));
        const text = draftTexts.get(path);
        if (text !== undefined) {
          return json(200, { commit: draft.baseCommit, path, kind: 'text', content: text });
        }
        const found = files?.contents?.[path];
        return found ? json(200, found) : json(404, problem(404, 'No such file'));
      }
      if (draftPath === '/publish' && request.method === 'POST') {
        await gates.publish;
        const result = published ?? { commit: draft.currentCommit ?? '' };
        if (result.files) files = result.files;
        if (result.list) list = result.list;
        draftTexts.clear();
        draft = {
          baseCommit: null,
          currentCommit: result.commit,
          version: draft.version + 1,
          files: [],
          problems: [],
          skillProblems: [],
          judged: true,
          notJudgedReason: null,
          movedUpstream: [],
          ...result.draft,
        };
        return json(200, { commit: result.commit });
      }
      if (draftPath === '/files' && request.method === 'PUT') {
        const { path, text, contentBase64 } = body as {
          path: string;
          text?: string;
          contentBase64?: string;
        };
        if (text !== undefined) draftTexts.set(path, text);
        const size =
          text === undefined ? Math.floor(((contentBase64 ?? '').length * 3) / 4) : text.length;
        const change = draft.files.find((item) => item.path === path)?.change;
        return json(
          200,
          upsert({
            path,
            size,
            movedFrom: null,
            skill: null,
            change: change ?? (inTree(path) ? 'modified' : 'added'),
          }),
        );
      }
      if (draftPath === '/files' && request.method === 'DELETE') {
        const path = search_.get('path') ?? '';
        const own = draft.files.find((item) => item.path === path);
        if (own?.change === 'added') {
          return json(200, touch({ files: draft.files.filter((item) => item.path !== path) }));
        }
        return json(
          200,
          upsert({ path, size: 0, movedFrom: null, skill: null, change: 'deleted' }),
        );
      }
      if (draftPath === '/files/revert') {
        const { path } = body as { path: string };
        draftTexts.delete(path);
        return json(200, touch({ files: draft.files.filter((item) => item.path !== path) }));
      }
      if (draftPath === '/files/move') {
        const { from, to } = body as { from: string; to: string };
        const text = draftTexts.get(from) ?? '';
        draftTexts.set(to, text);
        upsert({ path: from, size: 0, movedFrom: null, skill: null, change: 'deleted' });
        return json(
          200,
          upsert({ path: to, size: text.length, movedFrom: from, skill: null, change: 'added' }),
        );
      }
      return json(404, problem(404, 'Not Found'));
    }
    if (pathname === '/api/agents/definitions-repository/files') {
      return files ? json(200, files.tree) : json(404, problem(404, 'No files'));
    }
    if (pathname === '/api/agents/definitions-repository/files/content') {
      const path = new URL(request.url).searchParams.get('path') ?? '';
      const found = files?.contents?.[path];
      return found ? json(200, found) : json(404, problem(404, 'No such file'));
    }
    if (pathname === '/api/agents/definitions-repository') {
      return json(200, {
        project: project && {
          id: project.id,
          repository: repository && {
            state: repository.state,
            integrationBranch: repository.integrationBranch,
            headSha: repository.headSha ?? null,
            lastFetchedAt: repository.lastFetchedAt ?? null,
          },
        },
      });
    }
    if (pathname === '/api/projects' && request.method === 'POST') {
      const scriptedPost = scripted.shift();
      if (scriptedPost) return json(scriptedPost.status, scriptedPost.body);
      project = { ...DEFINITIONS_PROJECT, name: (body as { name: string }).name };
      return json(201, project);
    }
    if (project && pathname === `/api/projects/${project.id}`) {
      return json(200, {
        ...project,
        repository: repository && {
          state: repository.state,
          url: repository.url,
          integrationBranch: repository.integrationBranch,
        },
      });
    }
    const match = REPOSITORY.exec(pathname);
    if (project && match?.[1] === project.id) {
      if (match[2] === '/fetch' && repository) {
        repository = { ...repository, state: 'fetching' };
        return json(202, repository);
      }
      if (request.method === 'DELETE') {
        repository = null;
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST') {
        const { url, integrationBranch } = body as { url: string; integrationBranch: string };
        repository = {
          state: 'awaiting_key',
          url,
          integrationBranch,
          hasClone: false,
          publicKey: 'ssh-ed25519 c3ludGhldGlj studio-Agent-definitions',
        };
        return json(201, repository);
      }
      return repository ? json(200, repository) : json(404, problem(404, 'No repository'));
    }
    return json(404, problem(404, 'Not Found'));
  });
  vi.stubGlobal('fetch', fetch);

  return {
    /** The Repository as the server holds it. */
    get repository() {
      return repository;
    },
    /** The next read of an agent fails with this response. */
    failNextDetail(status: number, body: unknown) {
      detailFailures.push({ status, body });
    },
    /** Holds the answers of the list or of an agent until the returned function is called. */
    hold(what: 'list' | 'detail' | 'publish'): () => void {
      let release: () => void = () => undefined;
      gates[what] = new Promise<void>((resolve) => {
        release = () => {
          gates[what] = undefined;
          resolve();
        };
      });
      return release;
    },
    /** What a successful publish leaves: the new commit and the tree read at it. */
    willPublish(
      commit: string,
      after?: {
        files?: { tree: AgentFilesOutput; contents?: Record<string, AgentFileOutput> };
        list?: AgentListOutput;
        draft?: Partial<AgentDraftOutput>;
      },
    ) {
      published = { commit, ...after };
    },
    /** The files the next reads answer, as after a fetch brought new commits. */
    setFiles(next: { tree: AgentFilesOutput; contents?: Record<string, AgentFileOutput> }) {
      files = next;
    },
    /** The Draft as the server holds it. */
    get draft() {
      return draft;
    },
    /** Another writer changed the Draft: the server's version moves on. */
    changeDraftElsewhere(next: Partial<AgentDraftOutput>) {
      touch(next);
    },
    /** The next write to the Draft is refused with this response. */
    failNextDraftWrite(status: number, body: unknown) {
      draftFailures.push({ status, body });
    },
    /** The next read of the Providers fails with this response. */
    failNextProviders(status: number, body: unknown) {
      providerFailures.push({ status, body });
    },
    /** The next read of the agent list fails with this response. */
    failNextList(status: number, body: unknown) {
      listFailures.push({ status, body });
    },
    /** The agents the next reads answer, as after a fetch brought new commits. */
    setAgents(next: AgentListOutput, nextDetails?: Record<string, AgentDetailOutput>) {
      list = next;
      if (nextDetails) Object.assign(details, nextDetails);
    },
    /** The running fetch ends: the Repository is `ready` at `headSha`. */
    finishFetch(headSha: string) {
      if (repository) repository = { ...repository, state: 'ready', headSha };
    },
    /** The requests the page made, in order. */
    calls: () => calls,
    /** The next read (or, for a create, the next POST) gets this response. */
    respondNext(status: number, body: unknown) {
      scripted.push({ status, body });
    },
  };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}
