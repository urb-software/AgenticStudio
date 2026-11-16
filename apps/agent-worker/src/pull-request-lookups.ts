import {
  type FailingCheckLogsResult,
  type LookupErrorCode,
  type LookupPayload,
  type PullRequestCheck,
  type PullRequestStateName,
  type PullRequestStateResult,
  type RunPayload,
} from '@agentic-studio/contracts';
import { excerptAllowance, logExcerpt } from './check-logs.js';
import {
  type CheckReport,
  GitHubPullRequests,
  parseGitHubRemote,
  PullRequestFailedError,
  type PullRequestDetails,
  type PullRequestReader,
} from './github.js';
import { isRunBranchOf } from './run-branch.js';
import type { StudioApi } from './studio-api.js';

/**
 * Pull request lookups (Issue #142): the agent worker answers Studio's questions about a Run's
 * pull request through the Agent account. Everything it does here is a read: it starts no agent
 * CLI, changes nothing on the Git host and needs no Working copy.
 *
 * A lookup is limited to the Run's own pull request, and the worker checks that before it
 * answers: the remote must name a GitHub repository, the Run branch must be one Studio would
 * have named for this Run (`agent/…-r<run id>`), and the pull request must come from exactly
 * that branch of that repository and have been opened by the Agent account. Anything else is
 * rejected as `scope_mismatch`, and nothing beyond that one pull request is read.
 *
 * Issue #145: a `pull_request_state` lookup of a draft or open pull request also reads the checks
 * of its latest commit, and a `failing_check_logs` lookup reads the end of the log of each failed
 * check. Both are reads through the same scope check; a log is untrusted text that is only
 * capped and cleaned of control characters here (Studio redacts it before it is stored).
 */

/** What a lookup needs to know about the Run's pull request. */
interface PullRequestTarget {
  remoteUrl: string;
  pullRequestNumber: number;
  runBranch: string;
  runId: string;
  integrationBranch: string;
}

/** A lookup that cannot be answered: its code and the message for the operator. */
class LookupRefusal extends Error {
  constructor(
    readonly code: LookupErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'LookupRefusal';
  }
}

/** The routes of the Studio API the lookups use ({@link StudioApi} in production). */
export type LookupApi = Pick<StudioApi, 'claimLookups' | 'reportLookup'>;

export interface PullRequestLookupsOptions {
  api: LookupApi;
  /** The Agent account on GitHub: its token (when configured) and the REST API's base URL. */
  github: { token?: string; apiUrl: string };
  /** A development or test worker: `file://` fixture remotes name a repository too. */
  allowFileRemotes: boolean;
  /** Builds the reader (default: {@link GitHubPullRequests}). */
  reader?: (github: { token: string; apiUrl: string }) => PullRequestReader;
  logger: { info(message: string): void; error(message: string): void };
}

/** The lookups the worker loop serves, and the Follow-up pre-check ({@link PullRequestLookups}). */
export interface LookupService {
  /** Claims the waiting lookups and answers each; returns how many it handled. */
  serve(signal: AbortSignal): Promise<number>;
  /**
   * The state of the pull request a Follow-up would update (Issue #142): read before the agent
   * is started. `unknown` when it could not be read: that never stops a Follow-up.
   */
  followUpState(run: RunPayload, signal: AbortSignal): Promise<PullRequestStateName | 'unknown'>;
}

const NOT_CONFIGURED =
  'The Agent account is not configured on the agent worker: set STUDIO_AGENT_GITHUB_TOKEN in ' +
  "the agent worker's .env and restart it.";

export class PullRequestLookups implements LookupService {
  /** The Agent account's login, read once. */
  private login: Promise<string> | undefined;

  constructor(private readonly options: PullRequestLookupsOptions) {}

  async serve(signal: AbortSignal): Promise<number> {
    const { api, logger } = this.options;
    const lookups = await api.claimLookups(signal);
    for (const lookup of lookups) {
      if (signal.aborted) break;
      const answer = await this.answer(lookup, signal);
      // A stop (the worker shuts down) is no answer: the lookup is handed out again later.
      if (answer === null) break;
      try {
        await api.reportLookup(lookup.id, answer, signal);
      } catch (error) {
        if (signal.aborted) break;
        // Not held any more, or Studio is unreachable: the lease hands it out again.
        logger.error(`Reporting lookup ${lookup.id} failed: ${describe(error)}`);
      }
    }
    return lookups.length;
  }

  async followUpState(
    run: RunPayload,
    signal: AbortSignal,
  ): Promise<PullRequestStateName | 'unknown'> {
    if (run.pullRequestNumber === undefined || run.runBranch === undefined) return 'unknown';
    try {
      const result = await this.read(
        followUpTarget(run, run.pullRequestNumber, run.runBranch),
        signal,
        false,
      );
      return result.state;
    } catch (error) {
      signal.throwIfAborted();
      this.options.logger.error(
        `Reading the pull request of run ${run.runId} before its Follow-up failed: ${describe(error)}`,
      );
      return 'unknown';
    }
  }

  /** The answer to one lookup, or `null` when the worker is stopping. */
  private async answer(
    lookup: LookupPayload,
    signal: AbortSignal,
  ): Promise<Parameters<LookupApi['reportLookup']>[1] | null> {
    try {
      if (lookup.kind === 'failing_check_logs') {
        const result = await this.readFailingCheckLogs(lookupTarget(lookup), signal);
        return { ok: true, kind: 'failing_check_logs', result };
      }
      const result = await this.read(lookupTarget(lookup), signal, true);
      return { ok: true, kind: 'pull_request_state', result };
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof LookupRefusal) {
        return {
          ok: false,
          code: error.code,
          error: error.message,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        };
      }
      this.options.logger.error(
        `Lookup ${lookup.id} of run ${lookup.runId} failed: ${describe(error)}`,
      );
      return {
        ok: false,
        code: 'failed',
        error: 'The lookup failed. The agent worker log has the details.',
      };
    }
  }

  /**
   * Opens the Run's pull request after the scope check: the reader, the repository, the pull
   * request and its details, or `missing` when GitHub no longer has it. Throws
   * {@link LookupRefusal}.
   */
  private async openScope(
    target: PullRequestTarget,
    signal: AbortSignal,
  ): Promise<
    | { missing: true }
    | {
        missing?: undefined;
        reader: PullRequestReader;
        repository: { owner: string; repo: string };
        details: PullRequestDetails;
      }
  > {
    const repository = parseGitHubRemote(target.remoteUrl, this.options.allowFileRemotes);
    if (!repository) {
      throw new LookupRefusal(
        'scope_mismatch',
        'Git host not supported: lookups work only for GitHub repositories.',
      );
    }
    if (!isRunBranchOf(target.runBranch, target)) {
      throw new LookupRefusal(
        'scope_mismatch',
        'The branch is not a Run branch of this run, so nothing was read.',
      );
    }
    const token = this.options.github.token;
    if (!token) throw new LookupRefusal('failed', NOT_CONFIGURED);
    const reader = (this.options.reader ?? defaultReader)({
      token,
      apiUrl: this.options.github.apiUrl,
    });
    const pull = {
      owner: repository.owner,
      repo: repository.repo,
      number: target.pullRequestNumber,
    };
    let details;
    try {
      details = await reader.details(pull, signal);
    } catch (error) {
      // The pull request no longer exists.
      if (error instanceof PullRequestFailedError && error.status === 404) {
        return { missing: true };
      }
      throw error;
    }
    const fullName = `${repository.owner}/${repository.repo}`.toLowerCase();
    const login = await this.agentLogin(reader, signal);
    if (
      details.headRef !== target.runBranch ||
      details.headRepository?.toLowerCase() !== fullName ||
      details.author?.toLowerCase() !== login.toLowerCase()
    ) {
      throw new LookupRefusal(
        'scope_mismatch',
        "That is not the run's own pull request (its branch or author differs), so nothing more was read.",
      );
    }
    return { reader, repository, details };
  }

  /**
   * Reads the Run's pull request, after the scope check; throws {@link LookupRefusal}. With
   * `withChecks` (Issue #145) a draft or open pull request also gets the checks of its latest
   * commit.
   */
  private async read(
    target: PullRequestTarget,
    signal: AbortSignal,
    withChecks: boolean,
  ): Promise<PullRequestStateResult> {
    try {
      const scope = await this.openScope(target, signal);
      if (scope.missing) return { state: 'missing' };
      const { reader, repository, details } = scope;
      // Merged is merged, whether or not its branch was deleted afterwards.
      if (details.merged) return { state: 'merged' };
      const position = await reader.position(
        repository,
        target.integrationBranch,
        target.runBranch,
        signal,
      );
      if (position === null) {
        // A 404 also answers a missing integration branch: only a Run branch that is really gone
        // is a missing pull request (review S3 of #152).
        if (await reader.branchExists(repository, target.runBranch, signal)) {
          throw new LookupRefusal(
            'failed',
            'GitHub could not compare the Run branch with the integration branch. Check that the integration branch still exists.',
          );
        }
        return { state: 'missing' };
      }
      const state: PullRequestStateName =
        details.state === 'closed' ? 'closed' : details.draft ? 'draft' : 'open';
      return {
        state,
        behindBy: position.behindBy,
        aheadBy: position.aheadBy,
        ...(state !== 'closed' && details.mergeable !== null
          ? { mergeable: details.mergeable }
          : {}),
        ...(withChecks && state !== 'closed'
          ? await this.readChecks(reader, repository, details, signal)
          : {}),
      };
    } catch (error) {
      throw refusalOf(error);
    }
  }

  /**
   * The checks of the pull request's latest commit (Issue #145). When GitHub refuses to tell
   * (the Agent account lacks the permission), the answer says so instead of failing the lookup:
   * the pull request's state is still worth having.
   */
  private async readChecks(
    reader: PullRequestReader,
    repository: { owner: string; repo: string },
    details: PullRequestDetails,
    signal: AbortSignal,
  ): Promise<Pick<PullRequestStateResult, 'checks' | 'checksCommit' | 'checksUnavailable'>> {
    try {
      const reports = await reader.checks(
        repository,
        details.headSha,
        `${details.url}/checks`,
        signal,
      );
      const checks: PullRequestCheck[] = reports.map(
        ({ name, state, durationSeconds, url }): PullRequestCheck => ({
          name,
          state,
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
          url,
        }),
      );
      return { checksCommit: details.headSha, checks };
    } catch (error) {
      if (
        error instanceof PullRequestFailedError &&
        error.retryAfterSeconds === undefined &&
        (error.status === 403 || error.status === 404)
      ) {
        return { checksUnavailable: true };
      }
      throw error;
    }
  }

  /**
   * The failed checks of the pull request's latest commit with the end of each job's log
   * (Issue #145), after the scope check; throws {@link LookupRefusal}. A log that cannot be
   * read leaves the check in the answer with the reason.
   */
  private async readFailingCheckLogs(
    target: PullRequestTarget,
    signal: AbortSignal,
  ): Promise<FailingCheckLogsResult> {
    try {
      const scope = await this.openScope(target, signal);
      if (scope.missing || scope.details.merged || scope.details.state === 'closed') {
        throw new LookupRefusal(
          'failed',
          'The pull request is not open any more, so its failing checks were not read.',
        );
      }
      const { reader, repository, details } = scope;
      const reports = await reader.checks(
        repository,
        details.headSha,
        `${details.url}/checks`,
        signal,
      );
      const failed = reports.filter((report) => report.state === 'failed');
      const checks: FailingCheckLogsResult['checks'] = [];
      let used = 0;
      for (const report of failed) {
        const entry = await this.failedCheck(reader, repository, report, used, signal);
        used += entry.excerpt?.length ?? 0;
        checks.push(entry);
      }
      return { commit: details.headSha, checks };
    } catch (error) {
      throw refusalOf(error);
    }
  }

  private async failedCheck(
    reader: PullRequestReader,
    repository: { owner: string; repo: string },
    report: CheckReport,
    used: number,
    signal: AbortSignal,
  ): Promise<FailingCheckLogsResult['checks'][number]> {
    const base = { name: report.name, url: report.url };
    const summary = report.summary ? ` The check's summary: ${report.summary}` : '';
    const unavailable = (reason: string) => ({
      ...base,
      logAvailable: false,
      note: `Log unavailable: ${reason}${summary}`.slice(0, 500),
    });
    if (report.jobId === undefined) {
      return unavailable('this check does not run on GitHub Actions.');
    }
    const allowance = excerptAllowance(used);
    if (allowance === 0) return unavailable('the size limit for all logs was reached.');
    const outcome = await reader.jobLog(repository, report.jobId, signal);
    if ('unavailable' in outcome) return unavailable(outcome.unavailable);
    const excerpt = logExcerpt(outcome.log, allowance);
    if (excerpt === undefined) return unavailable('the log is empty.');
    return { ...base, logAvailable: true, excerpt };
  }

  private agentLogin(reader: PullRequestReader, signal: AbortSignal): Promise<string> {
    // A failed read is not kept: the next lookup asks again.
    const login = (this.login ??= reader.viewer(signal));
    login.catch(() => {
      if (this.login === login) this.login = undefined;
    });
    return login;
  }
}

function lookupTarget(lookup: LookupPayload): PullRequestTarget {
  return {
    remoteUrl: lookup.repository.remoteUrl,
    pullRequestNumber: lookup.pullRequestNumber,
    runBranch: lookup.runBranch,
    runId: lookup.runId,
    integrationBranch: lookup.integrationBranch,
  };
}

function followUpTarget(
  run: RunPayload,
  pullRequestNumber: number,
  runBranch: string,
): PullRequestTarget {
  return {
    remoteUrl: run.repository.remoteUrl,
    pullRequestNumber,
    runBranch,
    runId: run.runId,
    integrationBranch: run.integrationBranch,
  };
}

function defaultReader(github: { token: string; apiUrl: string }): PullRequestReader {
  return new GitHubPullRequests(github);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A refusal from the Git host as the lookup's own; anything else as it is. */
function refusalOf(error: unknown): unknown {
  if (!(error instanceof PullRequestFailedError)) return error;
  return new LookupRefusal(
    error.retryAfterSeconds === undefined ? 'failed' : 'rate_limited',
    error.retryAfterSeconds === undefined
      ? error.message
      : `GitHub asked to wait (${error.retryAfterSeconds} seconds) before the pull request is read again.`,
    error.retryAfterSeconds,
  );
}
