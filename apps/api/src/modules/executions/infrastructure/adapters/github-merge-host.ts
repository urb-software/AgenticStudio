import { z } from 'zod';
import { redactSecrets } from '../../../../platform/http/redact.js';
import {
  type HostCheck,
  type HostCheckState,
  type HostMergeRequest,
  type HostPullRequest,
  type MergeHost,
  type MergeHostFailure,
  type MergeHostResult,
  type PullRequestScope,
} from '../../application/ports/merge-host.js';
import { RunBranchRule } from '../../domain/value-objects/run-branch-rule.js';
import { MergeCredential } from '../../../../platform/config/merge-credential.js';
import { GitHubRepository } from '../../domain/value-objects/git-hub-repository.js';

export const GITHUB_API_URL = 'https://api.github.com';

export interface GitHubMergeHostOptions {
  /** `null`: every call answers `not_configured`. */
  credential: MergeCredential | null;
  /** The only host the token is sent to. */
  apiUrl?: string;
  allowFileRemotes?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 3600;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MESSAGE_MAX_LENGTH = 500;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const BODY_MAX_BYTES = 1024 * 1024;

const repositoryRef = z.object({ full_name: z.string() }).nullable();
const pullRequestSchema = z.object({
  node_id: z.string(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean().optional(),
  draft: z.boolean().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  head: z.object({ sha: z.string(), ref: z.string(), repo: repositoryRef }),
  base: z.object({ ref: z.string(), repo: repositoryRef }),
});
const checkRunsSchema = z.object({
  total_count: z.number().int(),
  check_runs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
});
const combinedStatusSchema = z.object({
  total_count: z.number().int().optional(),
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});
const mergeAnswerSchema = z.object({ merged: z.boolean() });
const graphqlAnswerSchema = z.object({
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});
const errorBodySchema = z.object({
  message: z.string().optional(),
  errors: z.array(z.union([z.string(), z.object({ message: z.string().optional() })])).optional(),
});

type Failed = { ok: false; failure: MergeHostFailure };
type Answer = { ok: true; json: unknown } | Failed;
type Verified = { ok: true; pullRequest: HostPullRequest; nodeId: string } | Failed;

/**
 * Merges and closes pull requests through the GitHub REST API with Studio's Merge credential.
 * Redirects are not followed, so the token never leaves the configured API host.
 */
export class GitHubMergeHost implements MergeHost {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly send: typeof fetch;
  private readonly now: () => number;
  readonly #credential: MergeCredential | null;

  constructor(private readonly options: GitHubMergeHostOptions) {
    this.#credential = options.credential;
    this.apiUrl = (options.apiUrl ?? GITHUB_API_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async readPullRequest(
    scope: PullRequestScope,
  ): Promise<MergeHostResult<{ pullRequest: HostPullRequest }>> {
    const verified = await this.verify(scope);
    return verified.ok ? { ok: true, pullRequest: verified.pullRequest } : verified;
  }

  async readChecks(
    scope: PullRequestScope,
    sha: string,
  ): Promise<MergeHostResult<{ checks: HostCheck[] }>> {
    return this.guarded(scope, async (repository) => {
      if (!COMMIT_SHA.test(sha)) return this.refusal('The commit is not a valid commit id.');
      const base = `/repos/${repository.fullName}/commits/${sha}`;
      const runs = await this.pages(`${base}/check-runs`, checkRunsSchema, (page) => ({
        total: page.total_count,
        items: page.check_runs.map((run) => ({ name: run.name, state: checkRunState(run) })),
      }));
      if (!runs.ok) return runs;
      const statuses = await this.pages(`${base}/status`, combinedStatusSchema, (page) => ({
        total: page.total_count ?? page.statuses.length,
        items: page.statuses.map((status) => ({
          name: status.context,
          state: commitStatusState(status.state),
        })),
      }));
      if (!statuses.ok) return statuses;
      return { ok: true, checks: [...runs.items, ...statuses.items] };
    });
  }

  async markReady(scope: PullRequestScope): Promise<MergeHostResult> {
    const verified = await this.verify(scope);
    if (!verified.ok) return verified;
    if (!verified.pullRequest.draft) return { ok: true };
    const answer = await this.call('POST', '/graphql', {
      query:
        'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }',
      variables: { id: verified.nodeId },
    });
    if (!answer.ok) return answer;
    const parsed = graphqlAnswerSchema.safeParse(answer.json);
    if (!parsed.success) return unavailable();
    if (parsed.data.errors?.length) {
      return this.refusal(parsed.data.errors.map((error) => error.message ?? '').join(' '));
    }
    return { ok: true };
  }

  async approve(scope: PullRequestScope, sha: string): Promise<MergeHostResult> {
    return this.guarded(scope, async (repository, number) => {
      if (!COMMIT_SHA.test(sha)) return this.refusal('The commit is not a valid commit id.');
      const answer = await this.call(
        'POST',
        `/repos/${repository.fullName}/pulls/${number}/reviews`,
        { event: 'APPROVE', commit_id: sha },
      );
      return answer.ok ? { ok: true } : answer;
    });
  }

  async merge(scope: PullRequestScope, request: HostMergeRequest): Promise<MergeHostResult> {
    return this.guarded(scope, async (repository, number) => {
      if (!COMMIT_SHA.test(request.sha)) {
        return this.refusal('The commit is not a valid commit id.');
      }
      const answer = await this.call('PUT', `/repos/${repository.fullName}/pulls/${number}/merge`, {
        sha: request.sha,
        merge_method: request.method === 'squash' ? 'squash' : 'merge',
        ...(request.title === undefined ? {} : { commit_title: request.title }),
        ...(request.message === undefined ? {} : { commit_message: request.message }),
      });
      if (!answer.ok) return answer;
      return mergeAnswerSchema.safeParse(answer.json).data?.merged === true
        ? { ok: true }
        : this.refusal('The host did not merge the pull request.');
    });
  }

  async close(scope: PullRequestScope): Promise<MergeHostResult> {
    return this.guarded(scope, async (repository, number) => {
      const answer = await this.call('PATCH', `/repos/${repository.fullName}/pulls/${number}`, {
        state: 'closed',
      });
      return answer.ok ? { ok: true } : answer;
    });
  }

  async deleteRunBranch(scope: PullRequestScope): Promise<MergeHostResult> {
    return this.guarded(scope, async (repository) => {
      const answer = await this.call(
        'DELETE',
        `/repos/${repository.fullName}/git/refs/heads/${scope.runBranch}`,
        undefined,
        true,
      );
      return answer.ok ? { ok: true } : answer;
    });
  }

  /** Runs `action` only after the pull request passed the scope check. */
  private async guarded<T extends object>(
    scope: PullRequestScope,
    action: (repository: GitHubRepository, number: number) => Promise<MergeHostResult<T>>,
  ): Promise<MergeHostResult<T>> {
    const verified = await this.verify(scope);
    if (!verified.ok) return verified;
    const resolved = this.repositoryOf(scope);
    if (!resolved.ok) return resolved;
    return action(resolved.repository, scope.pullRequestNumber);
  }

  private repositoryOf(
    scope: PullRequestScope,
  ): { ok: true; repository: GitHubRepository } | Failed {
    if (this.#credential === null) return notConfigured();
    const repository = GitHubRepository.fromRemote(scope.remoteUrl, {
      allowFileRemotes: this.options.allowFileRemotes ?? false,
    });
    if (repository === null) return { ok: false, failure: { code: 'unsupported_host' } };
    return { ok: true, repository };
  }

  private async verify(scope: PullRequestScope): Promise<Verified> {
    const resolved = this.repositoryOf(scope);
    if (!resolved.ok) return resolved;
    const { repository } = resolved;
    if (
      !RunBranchRule.of(scope.runId, scope.integrationBranch).accepts(scope.runBranch) ||
      !Number.isSafeInteger(scope.pullRequestNumber) ||
      scope.pullRequestNumber < 1
    ) {
      return { ok: false, failure: { code: 'scope_mismatch' } };
    }
    const answer = await this.call(
      'GET',
      `/repos/${repository.fullName}/pulls/${scope.pullRequestNumber}`,
    );
    if (!answer.ok) return answer;
    const parsed = pullRequestSchema.safeParse(answer.json);
    if (!parsed.success) return unavailable();
    const { head, base, ...data } = parsed.data;
    const expected = repository.fullName.toLowerCase();
    if (
      head.ref !== scope.runBranch ||
      head.repo?.full_name.toLowerCase() !== expected ||
      base.repo?.full_name.toLowerCase() !== expected
    ) {
      return { ok: false, failure: { code: 'scope_mismatch' } };
    }
    return {
      ok: true,
      nodeId: data.node_id,
      pullRequest: {
        state: data.merged === true ? 'merged' : data.state,
        draft: data.draft === true,
        headSha: head.sha,
        headRef: head.ref,
        baseRef: base.ref,
        mergeable: data.mergeable ?? null,
        mergeableState: data.mergeable_state ?? 'unknown',
      },
    };
  }

  private async pages<T, Item>(
    path: string,
    schema: z.ZodType<T>,
    read: (page: T) => { total: number; items: Item[] },
  ): Promise<{ ok: true; items: Item[] } | Failed> {
    const items: Item[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const answer = await this.call('GET', `${path}?per_page=${PAGE_SIZE}&page=${page}`);
      if (!answer.ok) return answer;
      const parsed = schema.safeParse(answer.json);
      if (!parsed.success) return unavailable();
      const result = read(parsed.data);
      items.push(...result.items);
      if (result.items.length < PAGE_SIZE || items.length >= result.total) {
        return { ok: true, items };
      }
    }
    return unavailable();
  }

  /** `missingIs422`: a 422 "Reference does not exist", not a 404, is how the host says a ref is gone. */
  private async call(
    method: string,
    path: string,
    body?: unknown,
    missingIs422 = false,
  ): Promise<Answer> {
    if (this.#credential === null) return notConfigured();
    let response: Response;
    try {
      response = await this.send(`${this.apiUrl}${path}`, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.#credential.reveal()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agentic-studio',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return unavailable();
    }
    if (response.ok) {
      const text = await readCapped(response);
      if (text === null) return unavailable();
      try {
        return { ok: true, json: text === '' ? null : JSON.parse(text) };
      } catch {
        return unavailable();
      }
    }
    const failure = await this.failureOf(response);
    const missing =
      missingIs422 &&
      response.status === 422 &&
      failure.code === 'refused' &&
      /^reference does not exist\.?$/i.test(failure.message.trim());
    return { ok: false, failure: missing ? { code: 'not_found' } : failure };
  }

  private async failureOf(response: Response): Promise<MergeHostFailure> {
    const { status } = response;
    if (status >= 500 || (status >= 300 && status < 400)) return { code: 'unavailable' };
    if (status === 404) return { code: 'not_found' };
    const limited =
      status === 429 ||
      (status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')));
    const body = (await readCapped(response)) ?? '';
    const message = this.hostMessage(body);
    if (limited || (status === 403 && /rate limit/i.test(message))) {
      return { code: 'rate_limited', retryAfterSeconds: this.retryAfter(response) };
    }
    return { code: 'refused', message };
  }

  private retryAfter(response: Response): number {
    const retry = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const seconds =
      Number.isFinite(retry) && retry > 0
        ? retry
        : Number.isFinite(reset) && reset > 0
          ? reset - this.now() / 1000
          : DEFAULT_RETRY_SECONDS;
    return Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(seconds)));
  }

  private refusal(text: string): Failed {
    return { ok: false, failure: { code: 'refused', message: this.redact(text) } };
  }

  /** The host's `message` and `errors` texts from an error body, redacted. */
  private hostMessage(body: string): string {
    let text = body;
    try {
      const parsed = errorBodySchema.safeParse(JSON.parse(body));
      if (parsed.success) {
        const errors = (parsed.data.errors ?? []).map((error) =>
          typeof error === 'string' ? error : (error.message ?? ''),
        );
        text = [parsed.data.message ?? '', ...errors].filter(Boolean).join(' ');
      }
    } catch {
      // A body that is not JSON is used as it is.
    }
    return this.redact(text);
  }

  /** Removes the token itself, then credential-looking text; at most 500 characters. */
  private redact(text: string): string {
    const token = this.#credential?.reveal();
    const withoutToken = token ? text.split(token).join('[redacted]') : text;
    const flat = redactSecrets(withoutToken).replace(/\s+/g, ' ').trim();
    return flat.length > MESSAGE_MAX_LENGTH ? `${flat.slice(0, MESSAGE_MAX_LENGTH - 1)}…` : flat;
  }
}

/** The body as text, or `null` when it is larger than the cap or cannot be read. */
async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function notConfigured(): Failed {
  return { ok: false, failure: { code: 'not_configured' } };
}

function unavailable(): Failed {
  return { ok: false, failure: { code: 'unavailable' } };
}

function checkRunState(run: { status: string; conclusion: string | null }): HostCheckState {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'neutral':
    case 'skipped':
      return 'neutral';
    default:
      return 'failure';
  }
}

function commitStatusState(state: string): HostCheckState {
  switch (state) {
    case 'success':
      return 'success';
    case 'pending':
      return 'pending';
    default:
      return 'failure';
  }
}
