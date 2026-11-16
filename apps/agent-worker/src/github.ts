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

/** The pull request could not be found or opened; `message` says what to check, never a token. */
export class PullRequestFailedError extends Error {
  constructor(message: string) {
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
  /** Replaces the pull request's title and description (Issue #141). */
  update(
    pull: PullRequestNumber & { title: string; body: string },
    signal: AbortSignal,
  ): Promise<void>;
}

const pullRequestAnswer = z.object({ number: z.number(), html_url: z.string() });

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
export class GitHubPullRequests implements PullRequestClient {
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

  async update(
    pull: PullRequestNumber & { title: string; body: string },
    signal: AbortSignal,
  ): Promise<void> {
    const answer = await this.call(
      'PATCH',
      this.pullPath(pull),
      { title: pull.title, body: pull.body },
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
    target: Pick<PullRequestTarget, 'owner' | 'repo'> & Partial<PullRequestTarget>,
    signal: AbortSignal,
    action: 'open' | 'read' | 'update' = 'open',
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
      throw new PullRequestFailedError(refusal(response.status, target, action));
    }
    return response.json().catch(() => {
      throw this.invalidAnswer();
    });
  }
}

/** What a refusal from GitHub means for the operator. */
function refusal(
  status: number,
  target: Pick<PullRequestTarget, 'owner' | 'repo'> & Partial<PullRequestTarget>,
  action: 'open' | 'read' | 'update',
): string {
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
