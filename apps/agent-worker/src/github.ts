import {
  PULL_REQUEST_CHECK_NAME_MAX_LENGTH,
  PULL_REQUEST_CHECKS_MAX,
  type PullRequestCheckState,
  type PullRequestRef,
  pullRequestRefSchema,
} from '@agentic-studio/contracts';
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
  /** The pull request's latest commit (Issue #145). */
  headSha: string;
  author: string | null;
}

/**
 * One check of a commit as the Git host reports it (Issue #145), from a check run or a commit
 * status. `jobId` is set for a GitHub Actions job, whose log can be read; `summary` is the
 * check's own short text, when it has one.
 */
export interface CheckReport {
  name: string;
  state: PullRequestCheckState;
  durationSeconds?: number;
  url: string;
  jobId?: number;
  summary?: string;
}

/** What reading one job log gave (Issue #145): its last lines, or why there is none. */
export type JobLogOutcome = { log: string } | { unavailable: string };

/** One review as the Git host reports it (Issue #146): its summary and verdict, not its comments. */
export interface ReviewReport {
  id: number;
  author: string;
  /** GitHub's state, lower case: approved, changes_requested, commented, dismissed or pending. */
  state: string;
  body: string;
  /** When the review was submitted; undefined while it is a pending draft. */
  submittedAt: string | undefined;
}

/** One inline comment on the pull request's diff (Issue #146). */
export interface InlineCommentReport {
  id: number;
  author: string;
  path: string;
  /** The line it is on now, or the one it was made on when the diff has moved; none for a file comment. */
  line: number | undefined;
  /** The diff lines around it, as GitHub gives them (a hunk). */
  diffHunk: string | undefined;
  body: string;
  createdAt: string;
}

/** One conversation comment on the pull request (Issue #146). */
export interface ConversationCommentReport {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

/** A listing read page by page: what was read, and whether the Git host had more. */
export interface Listing<T> {
  items: T[];
  more: boolean;
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
  /**
   * The checks of a commit (Issue #145): its check runs and combined statuses, at most
   * {@link PULL_REQUEST_CHECKS_MAX}. `fallbackUrl` is the link of a check that has none of its own.
   */
  checks(
    repository: { owner: string; repo: string },
    sha: string,
    fallbackUrl: string,
    signal: AbortSignal,
  ): Promise<CheckReport[]>;
  /**
   * The end of a GitHub Actions job's log (Issue #145), plain text; `unavailable` says why when
   * GitHub does not give it (no permission, expired, too large).
   */
  jobLog(
    repository: { owner: string; repo: string },
    jobId: number,
    signal: AbortSignal,
  ): Promise<JobLogOutcome>;
  /** The pull request's reviews (Issue #146), oldest first; of a long listing the newest ten pages. */
  reviews(pull: PullRequestNumber, signal: AbortSignal): Promise<Listing<ReviewReport>>;
  /** The inline comments on the pull request's diff (Issue #146), oldest first; of a long listing the newest ten pages. */
  inlineComments(
    pull: PullRequestNumber,
    signal: AbortSignal,
  ): Promise<Listing<InlineCommentReport>>;
  /** The conversation comments on the pull request (Issue #146), oldest first; of a long listing the newest ten pages. */
  conversationComments(
    pull: PullRequestNumber,
    signal: AbortSignal,
  ): Promise<Listing<ConversationCommentReport>>;
  /**
   * The ids of the inline comments in resolved review threads (Issue #146), through the GraphQL
   * API (a read-only query): GitHub's REST API does not tell which threads are resolved.
   */
  resolvedInlineCommentIds(pull: PullRequestNumber, signal: AbortSignal): Promise<Set<number>>;
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
    sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
    repo: z.object({ full_name: z.string() }).nullable().optional(),
  }),
  user: z.object({ login: z.string() }).nullable().optional(),
});

const userAnswer = z.object({ login: z.string() }).nullable().optional();

const reviewsAnswer = z.array(
  z.object({
    id: z.number(),
    user: userAnswer,
    state: z.string(),
    body: z.string().nullable().optional(),
    submitted_at: z.string().nullable().optional(),
  }),
);

const inlineCommentsAnswer = z.array(
  z.object({
    id: z.number(),
    user: userAnswer,
    path: z.string(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    diff_hunk: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    created_at: z.string(),
  }),
);

const conversationCommentsAnswer = z.array(
  z.object({
    id: z.number(),
    user: userAnswer,
    body: z.string().nullable().optional(),
    created_at: z.string(),
  }),
);

const reviewThreadsAnswer = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              reviewThreads: z.object({
                pageInfo: z.object({
                  hasNextPage: z.boolean(),
                  endCursor: z.string().nullable(),
                }),
                nodes: z.array(
                  z.object({
                    isResolved: z.boolean(),
                    comments: z.object({
                      pageInfo: z.object({ hasNextPage: z.boolean() }),
                      nodes: z.array(z.object({ databaseId: z.number().nullable() })),
                    }),
                  }),
                ),
              }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.unknown()).optional(),
});

/** Most pages read of one listing of comments (a hundred each): the rest is "more". */
const COMMENT_PAGES_MAX = 10;

/** Most pages of review threads read (a hundred each). */
const THREAD_PAGES_MAX = 10;

const REVIEW_THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){' +
  'pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}' +
  'nodes{isResolved comments(first:100){pageInfo{hasNextPage} nodes{databaseId}}}}}}}';

const compareAnswer = z.object({ ahead_by: z.int().min(0), behind_by: z.int().min(0) });

const viewerAnswer = z.object({ login: z.string().min(1) });

const checkRunsAnswer = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
      html_url: z.string().nullable().optional(),
      details_url: z.string().nullable().optional(),
      app: z.object({ slug: z.string().nullable().optional() }).nullable().optional(),
      output: z.object({ summary: z.string().nullable().optional() }).nullable().optional(),
    }),
  ),
});

const commitStatusAnswer = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      description: z.string().nullable().optional(),
      target_url: z.string().nullable().optional(),
    }),
  ),
});

/** Most check results one commit is asked for in one call. */
const CHECKS_PAGE_SIZE = 100;

/** A job log is read as a stream and only its end kept; a log beyond this is "too large". */
const JOB_LOG_MAX_BYTES = 64 * 1024 * 1024;

/** How much of a job log's end is kept while it streams, before the lines are chosen. */
const JOB_LOG_TAIL_BYTES = 256 * 1024;

/** The first of these that is a web link; anything else is not shown to the operator. */
function webLink(...candidates: (string | null | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate || candidate.length > 2048) continue;
    try {
      const url = new URL(candidate);
      // Never a link with credentials in it.
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password
      ) {
        return url.href;
      }
    } catch {
      // Not a link.
    }
  }
  return undefined;
}

/** How a check run stands, from GitHub's status and conclusion. */
function checkRunState(
  status: string,
  conclusion: string | null | undefined,
): PullRequestCheckState {
  if (status === 'in_progress') return 'running';
  if (status !== 'completed') return 'queued';
  switch (conclusion) {
    case 'success':
      return 'passed';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
    case 'neutral':
    case 'stale':
      return 'skipped';
    default:
      // failure, timed_out, action_required, startup_failure, or none given.
      return 'failed';
  }
}

function summaryText(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

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
      headSha: parsed.data.head.sha.toLowerCase(),
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

  async checks(
    repository: { owner: string; repo: string },
    sha: string,
    fallbackUrl: string,
    signal: AbortSignal,
  ): Promise<CheckReport[]> {
    const base =
      `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
      `/commits/${encodeURIComponent(sha)}`;
    const runsAnswer = checkRunsAnswer.safeParse(
      await this.call(
        'GET',
        `${base}/check-runs?per_page=${CHECKS_PAGE_SIZE}`,
        undefined,
        repository,
        signal,
        'read',
      ),
    );
    if (!runsAnswer.success) throw this.invalidAnswer();
    const statusAnswer = commitStatusAnswer.safeParse(
      await this.call(
        'GET',
        `${base}/status?per_page=${CHECKS_PAGE_SIZE}`,
        undefined,
        repository,
        signal,
        'read',
      ),
    );
    if (!statusAnswer.success) throw this.invalidAnswer();
    const reports: CheckReport[] = [];
    for (const run of runsAnswer.data.check_runs) {
      const started = run.started_at ? Date.parse(run.started_at) : Number.NaN;
      const ended = run.completed_at ? Date.parse(run.completed_at) : Number.NaN;
      const summary = summaryText(run.output?.summary);
      reports.push({
        name: run.name.slice(0, PULL_REQUEST_CHECK_NAME_MAX_LENGTH) || 'check',
        state: checkRunState(run.status, run.conclusion),
        ...(Number.isFinite(started) && Number.isFinite(ended) && ended >= started
          ? { durationSeconds: Math.round((ended - started) / 1000) }
          : {}),
        url: webLink(run.html_url, run.details_url) ?? fallbackUrl,
        ...(run.app?.slug === 'github-actions' && Number.isSafeInteger(run.id) && run.id > 0
          ? { jobId: run.id }
          : {}),
        ...(summary ? { summary } : {}),
      });
    }
    for (const status of statusAnswer.data.statuses) {
      const summary = summaryText(status.description);
      reports.push({
        name: status.context.slice(0, PULL_REQUEST_CHECK_NAME_MAX_LENGTH) || 'status',
        state:
          status.state === 'success' ? 'passed' : status.state === 'pending' ? 'running' : 'failed',
        url: webLink(status.target_url) ?? fallbackUrl,
        ...(summary ? { summary } : {}),
      });
    }
    return reports.slice(0, PULL_REQUEST_CHECKS_MAX);
  }

  async reviews(pull: PullRequestNumber, signal: AbortSignal): Promise<Listing<ReviewReport>> {
    const { items, more } = await this.listing(`${this.pullPath(pull)}/reviews`, pull, signal);
    const parsed = reviewsAnswer.safeParse(items);
    if (!parsed.success) throw this.invalidAnswer();
    return {
      more,
      items: parsed.data.map((review) => ({
        id: review.id,
        author: review.user?.login ?? 'ghost',
        state: review.state.toLowerCase(),
        body: review.body ?? '',
        submittedAt: review.submitted_at ?? undefined,
      })),
    };
  }

  async inlineComments(
    pull: PullRequestNumber,
    signal: AbortSignal,
  ): Promise<Listing<InlineCommentReport>> {
    const { items, more } = await this.listing(`${this.pullPath(pull)}/comments`, pull, signal);
    const parsed = inlineCommentsAnswer.safeParse(items);
    if (!parsed.success) throw this.invalidAnswer();
    return {
      more,
      items: parsed.data.map((comment) => {
        const line = comment.line ?? comment.original_line ?? undefined;
        return {
          id: comment.id,
          author: comment.user?.login ?? 'ghost',
          path: comment.path,
          line: line !== undefined && Number.isSafeInteger(line) && line > 0 ? line : undefined,
          diffHunk: comment.diff_hunk ?? undefined,
          body: comment.body ?? '',
          createdAt: comment.created_at,
        };
      }),
    };
  }

  async conversationComments(
    pull: PullRequestNumber,
    signal: AbortSignal,
  ): Promise<Listing<ConversationCommentReport>> {
    const path = `repos/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/issues/${pull.number}/comments`;
    const { items, more } = await this.listing(path, pull, signal);
    const parsed = conversationCommentsAnswer.safeParse(items);
    if (!parsed.success) throw this.invalidAnswer();
    return {
      more,
      items: parsed.data.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? 'ghost',
        body: comment.body ?? '',
        createdAt: comment.created_at,
      })),
    };
  }

  async resolvedInlineCommentIds(
    pull: PullRequestNumber,
    signal: AbortSignal,
  ): Promise<Set<number>> {
    const resolved = new Set<number>();
    let after: string | null = null;
    for (let page = 0; page < THREAD_PAGES_MAX; page += 1) {
      const response = await this.send(
        'POST',
        '',
        {
          query: REVIEW_THREADS_QUERY,
          variables: { owner: pull.owner, name: pull.repo, number: pull.number, after },
        },
        pull,
        signal,
        'read',
        'error',
        this.graphqlUrl(),
      );
      const parsed = reviewThreadsAnswer.safeParse(
        await response.json().catch(() => {
          throw this.invalidAnswer();
        }),
      );
      const threads = parsed.success
        ? parsed.data.data?.repository?.pullRequest?.reviewThreads
        : undefined;
      if (!parsed.success || parsed.data.errors !== undefined || !threads) {
        throw new PullRequestFailedError(
          'GitHub could not tell which review threads are resolved. Check that the token of the ' +
            'Agent account can read pull requests, then load the comments again.',
        );
      }
      for (const thread of threads.nodes) {
        if (!thread.isResolved) continue;
        // The comments after the hundredth of a resolved thread could not be told from unresolved
        // ones: refuse rather than show them.
        if (thread.comments.pageInfo.hasNextPage) {
          throw new PullRequestFailedError(
            'A resolved review thread has too many comments to tell which are resolved.',
          );
        }
        for (const comment of thread.comments.nodes) {
          if (comment.databaseId !== null) resolved.add(comment.databaseId);
        }
      }
      if (!threads.pageInfo.hasNextPage || threads.pageInfo.endCursor === null) return resolved;
      after = threads.pageInfo.endCursor;
    }
    // More threads than that: the rest could not be told apart, so nothing is shown.
    throw new PullRequestFailedError(
      'The pull request has too many review threads to tell which are resolved.',
    );
  }

  /** The GraphQL endpoint of the same GitHub as the REST API (api/v3 on an Enterprise server). */
  private graphqlUrl(): string {
    const api = this.options.apiUrl;
    return api.endsWith('/api/v3')
      ? `${api.slice(0, -'/api/v3'.length)}/api/graphql`
      : `${api}/graphql`;
  }

  /**
   * A paged listing, oldest first, of at most {@link COMMENT_PAGES_MAX} pages of a hundred: when the
   * host has more pages than that, the newest pages are read (the first call only tells how many
   * there are, from the `Link` header's last page) and `more` says the older ones are left out.
   */
  private async listing(
    path: string,
    target: PullRequestNumber,
    signal: AbortSignal,
  ): Promise<Listing<unknown>> {
    const first = await this.listingPage(path, 1, target, signal);
    if (first.last <= 1) return { items: first.items, more: false };
    const lowest = Math.max(2, first.last - COMMENT_PAGES_MAX + 1);
    const items = first.last <= COMMENT_PAGES_MAX ? [...first.items] : [];
    for (let page = lowest; page <= first.last; page += 1) {
      items.push(...(await this.listingPage(path, page, target, signal)).items);
    }
    return { items, more: first.last > COMMENT_PAGES_MAX };
  }

  /** One page of a listing, with the number of the last page when the host says so. */
  private async listingPage(
    path: string,
    page: number,
    target: PullRequestNumber,
    signal: AbortSignal,
  ): Promise<{ items: unknown[]; last: number }> {
    const response = await this.send(
      'GET',
      `${path}?per_page=${CHECKS_PAGE_SIZE}&page=${page}`,
      undefined,
      target,
      signal,
      'read',
    );
    const answer: unknown = await response.json().catch(() => {
      throw this.invalidAnswer();
    });
    if (!Array.isArray(answer)) throw this.invalidAnswer();
    const link = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(
      response.headers.get('link') ?? '',
    );
    return { items: answer, last: link ? Number(link[1]) : page };
  }

  async jobLog(
    repository: { owner: string; repo: string },
    jobId: number,
    signal: AbortSignal,
  ): Promise<JobLogOutcome> {
    const path =
      `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}` +
      `/actions/jobs/${jobId}/logs`;
    let response: Response;
    try {
      response = await this.send('GET', path, undefined, repository, signal, 'read', 'manual');
      // GitHub answers with a redirect to the log's download address, which needs no token and
      // never gets it. Only an https address, or one of the API's own origin, is followed.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        const target = location ? this.logAddress(location) : undefined;
        if (!target) return { unavailable: 'GitHub gave no usable address for the log.' };
        response = await this.download(target, signal);
      }
    } catch (error) {
      if (
        error instanceof PullRequestFailedError &&
        (error.status === 404 || error.status === 410 || error.status === 403) &&
        error.retryAfterSeconds === undefined
      ) {
        return {
          unavailable:
            error.status === 410
              ? 'The log has expired.'
              : 'The Agent account cannot read the log, or it was removed.',
        };
      }
      throw error;
    }
    const body = response.body;
    if (!body) return { unavailable: 'The log is empty.' };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let kept = 0;
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > JOB_LOG_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { unavailable: 'The log is too large to read.' };
        }
        chunks.push(value);
        kept += value.byteLength;
        // Only the end is wanted: drop whole chunks that can no longer reach it.
        while (chunks.length > 1 && kept - chunks[0]!.byteLength >= JOB_LOG_TAIL_BYTES) {
          kept -= chunks.shift()!.byteLength;
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      return { unavailable: 'The log could not be read to the end.' };
    }
    const bytes = Buffer.concat(chunks);
    return {
      log: bytes.subarray(Math.max(0, bytes.length - JOB_LOG_TAIL_BYTES)).toString('utf8'),
    };
  }

  /** The address of a log download from a redirect, or `undefined` when it must not be followed. */
  private logAddress(location: string): URL | undefined {
    try {
      const target = new URL(location, `${this.options.apiUrl}/`);
      const sameOrigin = target.origin === new URL(this.options.apiUrl).origin;
      return target.protocol === 'https:' || (sameOrigin && target.protocol === 'http:')
        ? target
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Downloads a log from its redirect address: no credentials, no further redirect. */
  private async download(target: URL, signal: AbortSignal): Promise<Response> {
    const call = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await call(target, {
        method: 'GET',
        headers: { 'User-Agent': 'agentic-studio-agent-worker' },
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(GITHUB_TIMEOUT_MS), signal]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PullRequestFailedError('The log could not be downloaded.', 404);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PullRequestFailedError('The log could not be downloaded.', response.status);
    }
    return response;
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
    const response = await this.send(method, path, body, target, signal, action);
    return response.json().catch(() => {
      throw this.invalidAnswer();
    });
  }

  /** One call to the API; throws {@link PullRequestFailedError} unless GitHub answered 2xx. */
  private async send(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: object | undefined,
    target: (Pick<PullRequestTarget, 'owner' | 'repo'> & Partial<PullRequestTarget>) | undefined,
    signal: AbortSignal,
    action: 'open' | 'read' | 'update' | 'identify',
    redirect: 'error' | 'manual' = 'error',
    /** The full address, when the call is not to the REST API (the GraphQL endpoint). */
    address?: string,
  ): Promise<Response> {
    const call = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await call(address ?? `${this.options.apiUrl}/${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agentic-studio-agent-worker',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect,
        signal: AbortSignal.any([AbortSignal.timeout(GITHUB_TIMEOUT_MS), signal]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PullRequestFailedError(
        `GitHub could not be reached to ${action} the pull request. Check the network of the agent ` +
          'worker and STUDIO_AGENT_GITHUB_API_URL, then retry the delivery.',
      );
    }
    if (redirect === 'manual' && response.status >= 300 && response.status < 400) return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PullRequestFailedError(
        refusal(response.status, target, action),
        response.status,
        rateLimitWait(response),
      );
    }
    return response;
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
