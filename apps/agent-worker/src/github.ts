import { type PullRequestRef, pullRequestRefSchema } from '@agentic-studio/contracts';
import { z } from 'zod';

/**
 * The Agent account's side of GitHub (Issue #102, ADR 0002): which GitHub repository a
 * Project's remote names, and the draft pull request of a Run branch. GitHub is the only
 * supported host. The token comes from the worker's own environment and is sent only to the
 * configured API, never logged.
 */

/** A GitHub repository named by a Project's remote, and how the remote is reached. */
export interface GitHubRepository {
  owner: string;
  repo: string;
  /** `file` only for a development or test worker's fixture remote. */
  transport: 'https' | 'ssh' | 'file';
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function repository(
  owner: string | undefined,
  name: string | undefined,
  transport: GitHubRepository['transport'],
): GitHubRepository | null {
  const repo = name?.replace(/\.git$/, '');
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || /^\.+$/.test(repo)) {
    return null;
  }
  return { owner, repo, transport };
}

/**
 * The GitHub repository a remote names: `https://github.com/<owner>/<repo>[.git]`,
 * `git@github.com:<owner>/<repo>[.git]` or `ssh://git@github.com[:port]/<owner>/<repo>[.git]`.
 * `null` for any other host or shape ("Git host not supported"). A development or test worker
 * (`allowFileRemotes`) also takes a `file://` fixture remote, named by its last two path parts.
 */
export function parseGitHubRemote(
  remoteUrl: string,
  allowFileRemotes: boolean,
): GitHubRepository | null {
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(remoteUrl);
  if (scp) return repository(scp[1], scp[2], 'ssh');
  if (allowFileRemotes && remoteUrl.startsWith('file:///')) {
    const parts = remoteUrl.slice('file://'.length).split('/').filter(Boolean);
    return repository(parts.at(-2), parts.at(-1), 'file');
  }
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null;
  const transport =
    url.protocol === 'https:' && !url.username && !url.password && !url.port
      ? 'https'
      : url.protocol === 'ssh:' && url.username === 'git' && !url.password
        ? 'ssh'
        : null;
  if (!transport) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return repository(parts[0], parts[1], transport);
}

/** A draft pull request to open (or reuse) for a Run branch. */
export interface PullRequestTarget {
  owner: string;
  repo: string;
  /** The Run branch. */
  head: string;
  /** The integration branch. */
  base: string;
  title: string;
  body: string;
}

export interface OpenedPullRequest extends PullRequestRef {
  /** Whether an open pull request of the Run branch already existed. */
  reused: boolean;
}

/**
 * The pull request could not be found or opened; `message` says what to check, never a token.
 * Issue #142: `status` is GitHub's answer when it refused, and `retryAfterSeconds` is set when
 * the refusal is a rate limit (how long GitHub asks to wait).
 */
export class PullRequestFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PullRequestFailedError';
  }
}

/** One pull request of a repository, by number (Issue #141). */
export interface PullRequestNumber {
  owner: string;
  repo: string;
  number: number;
}

/** A pull request's state on GitHub (Issue #141): open, or closed (merged or not). */
export interface PullRequestState extends PullRequestRef {
  state: 'open' | 'closed';
  merged: boolean;
}

/** The pull request client the delivery uses ({@link GitHubPullRequests} in production). */
export interface PullRequestClient {
  openDraft(target: PullRequestTarget, signal: AbortSignal): Promise<OpenedPullRequest>;
  /** The Run's recorded pull request, by number (Issue #141). */
  get(pull: PullRequestNumber, signal: AbortSignal): Promise<PullRequestState>;
  /**
   * Replaces the pull request's title and, when given, its description (Issue #141; review S7
   * of #150: a title alone keeps the description).
   */
  update(
    pull: PullRequestNumber & { title: string; body?: string },
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * A pull request as a lookup reads it (Issue #142): where it stands, whether GitHub says it can
 * be merged, and the facts the lookup's scope check needs (which branch of which repository it
 * comes from, and who opened it).
 */
export interface PullRequestDetails extends PullRequestRef {
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  /** GitHub's verdict; `null` while it has not worked it out yet. */
  mergeable: boolean | null;
  headRef: string;
  /** `owner/repo` of the head branch, `null` when its repository is gone. */
  headRepository: string | null;
  author: string | null;
}

/** A Run branch's position against the integration branch (Issue #142). */
export interface BranchPosition {
  behindBy: number;
  aheadBy: number;
}

/**
 * The reads a pull request lookup makes through the Agent account (Issue #142), all `GET`:
 * the pull request, how far its branch is from the integration branch, and who the Agent
 * account is. The client the delivery uses ({@link PullRequestClient}) does not need them.
 */
export interface PullRequestReader {
  details(pull: PullRequestNumber, signal: AbortSignal): Promise<PullRequestDetails>;
  /** The head branch against the base; `null` when the head branch no longer exists. */
  position(
    repository: { owner: string; repo: string },
    base: string,
    head: string,
    signal: AbortSignal,
  ): Promise<BranchPosition | null>;
  /**
   * Whether the branch still exists (review S3 of #152: told apart from a missing integration
   * branch when a comparison answers 404).
   */
  branchExists(
    repository: { owner: string; repo: string },
    branch: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** The login of the Agent account (the token's own user). */
  viewer(signal: AbortSignal): Promise<string>;
}

const pullRequestAnswer = z.object({ number: z.number(), html_url: z.string() });

const pullRequestDetailsAnswer = pullRequestAnswer.extend({
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable().optional(),
  }),
  user: z.object({ login: z.string() }).nullable().optional(),
});

const compareAnswer = z.object({ ahead_by: z.int().min(0), behind_by: z.int().min(0) });

const viewerAnswer = z.object({ login: z.string().min(1) });

const pullRequestStateAnswer = pullRequestAnswer.extend({
  state: z.enum(['open', 'closed']),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
});

/** Longest wait for one GitHub API call. */
const GITHUB_TIMEOUT_MS = 30_000;

/**
 * GitHub's REST API as the Agent account: reuses the open pull request of the Run branch, or
 * opens a draft one against the integration branch. Delivery is safe to repeat: a second
 * delivery finds the first one's pull request.
 */
export class GitHubPullRequests implements PullRequestClient, PullRequestReader {
  constructor(
    private readonly options: {
      /** Base URL of the REST API, without a trailing slash. */
      apiUrl: string;
      token: string;
      fetch?: typeof fetch;
    },
  ) {}

  async openDraft(target: PullRequestTarget, signal: AbortSignal): Promise<OpenedPullRequest> {
    const pulls = `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls`;
    const query = new URLSearchParams({
      state: 'open',
      head: `${target.owner}:${target.head}`,
      per_page: '1',
    });
    const open = await this.call('GET', `${pulls}?${query}`, undefined, target, signal);
    const existing = z.array(pullRequestAnswer).safeParse(open);
    if (!existing.success) throw this.invalidAnswer();
    if (existing.data[0]) return { ...this.ref(existing.data[0]), reused: true };
    const created = await this.call(
      'POST',
      pulls,
      {
        title: target.title,
        body: target.body,
        head: target.head,
        base: target.base,
        draft: true,
      },
      target,
      signal,
    );
    const parsed = pullRequestAnswer.safeParse(created);
    if (!parsed.success) throw this.invalidAnswer();
    return { ...this.ref(parsed.data), reused: false };
  }

  async get(pull: PullRequestNumber, signal: AbortSignal): Promise<PullRequestState> {
    const answer = await this.call('GET', this.pullPath(pull), undefined, pull, signal, 'read');
    const parsed = pullRequestStateAnswer.safeParse(answer);
    if (!parsed.success || parsed.data.number !== pull.number) throw this.invalidAnswer();
    return {
      ...this.ref(parsed.data),
      state: parsed.data.state,
      merged: parsed.data.merged === true || Boolean(parsed.data.merged_at),
    };
  }

  async details(pull: PullRequestNumber, signal: AbortSignal): Promise<PullRequestDetails> {
    const answer = await this.call('GET', this.pullPath(pull), undefined, pull, signal, 'read');
    const parsed = pullRequestDetailsAnswer.safeParse(answer);
    if (!parsed.success || parsed.data.number !== pull.number) throw this.invalidAnswer();
    return {
      ...this.ref(parsed.data),
      state: parsed.data.state,
      merged: parsed.data.merged === true || Boolean(parsed.data.merged_at),
      draft: parsed.data.draft === true,
      mergeable: parsed.data.mergeable ?? null,
      headRef: parsed.data.head.ref,
      headRepository: parsed.data.head.repo?.full_name ?? null,
      author: parsed.data.user?.login ?? null,
    };
  }

  async position(
    repository: { owner: string; repo: string },
    base: string,
    head: string,
    signal: AbortSignal,
  ): Promise<BranchPosition | null> {
    const branch = (name: string) => name.split('/').map(encodeURIComponent).join('/');
    const path =
      `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
      `/compare/${branch(base)}...${branch(head)}`;
    let answer: unknown;
    try {
      answer = await this.call('GET', path, undefined, repository, signal, 'read');
    } catch (error) {
      // The head (or base) branch is gone.
      if (error instanceof PullRequestFailedError && error.status === 404) return null;
      throw error;
    }
    const parsed = compareAnswer.safeParse(answer);
    if (!parsed.success) throw this.invalidAnswer();
    return { behindBy: parsed.data.behind_by, aheadBy: parsed.data.ahead_by };
  }

  async branchExists(
    repository: { owner: string; repo: string },
    branch: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const path =
      `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
      `/branches/${branch.split('/').map(encodeURIComponent).join('/')}`;
    try {
      await this.call('GET', path, undefined, repository, signal, 'read');
      return true;
    } catch (error) {
      if (error instanceof PullRequestFailedError && error.status === 404) return false;
      throw error;
    }
  }

  async viewer(signal: AbortSignal): Promise<string> {
    const answer = await this.call('GET', 'user', undefined, undefined, signal, 'identify');
    const parsed = viewerAnswer.safeParse(answer);
    if (!parsed.success) throw this.invalidAnswer();
    return parsed.data.login;
  }

  async update(
    pull: PullRequestNumber & { title: string; body?: string },
    signal: AbortSignal,
  ): Promise<void> {
    const answer = await this.call(
      'PATCH',
      this.pullPath(pull),
      { title: pull.title, ...(pull.body === undefined ? {} : { body: pull.body }) },
      pull,
      signal,
      'update',
    );
    if (!pullRequestAnswer.safeParse(answer).success) throw this.invalidAnswer();
  }

  private pullPath(pull: PullRequestNumber): string {
    return `repos/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/pulls/${pull.number}`;
  }

  private ref(answer: z.infer<typeof pullRequestAnswer>): PullRequestRef {
    const ref = pullRequestRefSchema.safeParse({ url: answer.html_url, number: answer.number });
    if (!ref.success) throw this.invalidAnswer();
    return ref.data;
  }

  private invalidAnswer() {
    return new PullRequestFailedError(
      'GitHub gave an answer that is not a pull request. Check STUDIO_AGENT_GITHUB_API_URL on ' +
        'the agent worker.',
    );
  }

  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: object | undefined,
    target: (Pick<PullRequestTarget, 'owner' | 'repo'> & Partial<PullRequestTarget>) | undefined,
    signal: AbortSignal,
    action: 'open' | 'read' | 'update' | 'identify' = 'open',
  ): Promise<unknown> {
    const call = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await call(`${this.options.apiUrl}/${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agentic-studio-agent-worker',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(GITHUB_TIMEOUT_MS), signal]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PullRequestFailedError(
        `GitHub could not be reached to ${action} the pull request. Check the network of the agent ` +
          'worker and STUDIO_AGENT_GITHUB_API_URL, then retry the delivery.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PullRequestFailedError(
        refusal(response.status, target, action),
        response.status,
        rateLimitWait(response),
      );
    }
    return response.json().catch(() => {
      throw this.invalidAnswer();
    });
  }
}

/**
 * How long GitHub asks to wait when it refused for a rate limit (Issue #142): a 429, or a 403
 * that says so (`retry-after`, or `x-ratelimit-remaining: 0` until `x-ratelimit-reset`);
 * `undefined` for any other refusal. At least one second.
 */
function rateLimitWait(response: Response, now = Date.now()): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  const reset = response.headers.get('x-ratelimit-reset');
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (retryAfter !== null || response.headers.get('x-ratelimit-remaining') === '0'));
  if (!limited) return undefined;
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) {
    return Math.max(1, Math.ceil(Number(retryAfter)));
  }
  if (reset !== null && Number.isFinite(Number(reset))) {
    return Math.max(1, Math.ceil(Number(reset) - now / 1000));
  }
  return 60;
}

/** What a refusal from GitHub means for the operator. */
function refusal(
  status: number,
  target: (Pick<PullRequestTarget, 'owner' | 'repo'> & Partial<PullRequestTarget>) | undefined,
  action: 'open' | 'read' | 'update' | 'identify',
): string {
  if (target === undefined || action === 'identify') {
    return (
      `Reading the Agent account failed: GitHub answered ${status}. Check ` +
      'STUDIO_AGENT_GITHUB_TOKEN on the agent worker.'
    );
  }
  const name = `${target.owner}/${target.repo}`;
  const what = {
    open: 'Opening the pull request',
    read: "Reading the run's pull request",
    update: "Updating the run's pull request",
  }[action];
  switch (status) {
    case 401:
      return (
        `${what} failed: GitHub answered 401 (the token of the Agent account is ` +
        'not valid). Check STUDIO_AGENT_GITHUB_TOKEN on the agent worker.'
      );
    case 403:
    case 404:
      return (
        `${what} failed: GitHub answered ${status}. Check that the Agent ` +
        `account can open pull requests in ${name} and that its token covers that repository.`
      );
    case 422:
      return action === 'open'
        ? `${what} failed: GitHub answered 422. Check that the integration ` +
            `branch ${target.base ?? ''} exists in ${name}.`
        : `${what} failed: GitHub answered 422. Check the pull request in ${name}.`;
    default:
      return (
        `${what} failed: GitHub answered ${status}. Check the access of the ` +
        'Agent account and the status of GitHub, then retry the delivery.'
      );
  }
}
