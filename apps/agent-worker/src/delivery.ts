import {
  PROVIDER_NAMES,
  type RunCheck,
  type RunDelivery,
  type RunPayload,
  type RunStepResult,
  runStepResultSchema,
} from '@agentic-studio/contracts';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  GIT_TIMEOUTS,
  GitCommandError,
  type GitOptions,
  type GitRunner,
  REMOTE_GIT_TRANSPORTS,
  WORKER_GIT_TRANSPORTS,
} from './git.js';
import {
  GitHubPullRequests,
  parseGitHubRemote,
  type PullRequestClient,
  PullRequestFailedError,
} from './github.js';
import { isRunBranchOf } from './run-branch.js';
import { composeProjectName, runDirectories } from './run-layout.js';
import { studioPathspecs } from './studio-paths.js';
import { diffBaseOf, onBranch, type PreparedRun, readRunFile } from './working-copy.js';

/**
 * Delivery of a Run's result (Issue #102, ADR 0002): after a `done` Run step the worker commits
 * what the agent left (never a file Studio placed), pushes exactly the Run branch and opens a
 * draft pull request as the Agent account. A delivery retry repeats it from the Working copy.
 */

/** The delivery could not be completed; `detail` says why and what to check (no token, no path). */
export class DeliveryFailedError extends Error {
  /**
   * @param branchPushed the Run branch was already pushed when the delivery failed (the pull
   * request could not be opened): a cancelled Run records it (review of #124).
   */
  constructor(
    readonly detail: string,
    readonly branchPushed = false,
    /** With `branchPushed` (Issue #141): the commit the push left the remote Run branch at. */
    readonly pushedCommit?: string,
  ) {
    super(detail);
    this.name = 'DeliveryFailedError';
  }
}

/** The delivery port of the worker loop: {@link Deliveries} in production. */
export interface DeliveryPort {
  /**
   * After a `done` Run step: keeps the agent's result for a delivery retry, and commits what is
   * left uncommitted on the Run branch as the Agent account, leaving out every Studio-placed
   * path. Throws {@link DeliveryFailedError}.
   */
  commit(
    prepared: PreparedRun,
    run: RunPayload,
    result: RunStepResult,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Pushes the Run branch and opens (or reuses) its draft pull request; `none` when the Run
   * branch has no commits beyond the start commit. Issue #141: a Run with a recorded pull
   * request (`pullRequestNumber`) delivers to it only: refused before the push when it is no
   * longer open, its title and description replaced when the agent gave new ones; a delivered
   * result carries the pushed commit. Throws {@link DeliveryFailedError}.
   */
  deliver(
    prepared: PreparedRun,
    run: RunPayload,
    result: RunStepResult,
    signal: AbortSignal,
  ): Promise<RunDelivery>;
  /**
   * For a delivery retry: the Run's Working copy and the agent's kept result. Throws
   * {@link DeliveryFailedError} ("Working copy no longer exists") when they are gone.
   */
  locate(run: RunPayload): Promise<{ prepared: PreparedRun; result: RunStepResult }>;
}

export interface DeliveriesOptions {
  /** Absolute directory of the caches and the Runs' directories. */
  dataDir: string;
  git: GitRunner;
  /** The Agent account's Git identity, the author and committer of the worker's commit. */
  agentGitName: string;
  agentGitEmail: string;
  /** A development or test worker: `file://` fixture remotes are delivered too. */
  allowFileRemotes: boolean;
  /** The Agent account on GitHub: its token (when configured) and the REST API's base URL. */
  github: { token?: string; apiUrl: string };
  /** Builds the pull request client (default: {@link GitHubPullRequests}). */
  pullRequests?: (github: { token: string; apiUrl: string }) => PullRequestClient;
  logger: { error(message: string): void };
}

/** Longest first line of the worker's commit message. */
const SUBJECT_MAX_LENGTH = 72;
const SUBJECT_PREFIX = 'agent: ';
/** GitHub's limits for a pull request's title and description. */
const TITLE_MAX_LENGTH = 256;
const BODY_MAX_LENGTH = 65_536;
/** Most checks listed in the footer; the rest are counted. */
const FOOTER_CHECKS_MAX = 50;

export const NO_WORKING_COPY = 'Working copy no longer exists';

/**
 * Commits, pushes and opens pull requests for Runs (Issue #102). Every Git command goes
 * through the worker's hardened {@link GitRunner}. The push is exactly
 * `git push -- <remote> refs/heads/<Run branch>:refs/heads/<Run branch>`: one ref, never
 * `--force`, so it updates the remote Run branch only by a fast-forward (a remote branch with
 * commits this Run lacks is refused) and never touches any other branch. The Agent account's
 * token reaches Git only for an HTTPS push, as an `http.extraHeader` in that command's
 * environment; SSH remotes use the agent user's own SSH setup.
 */
export class Deliveries implements DeliveryPort {
  constructor(private readonly options: DeliveriesOptions) {}

  async commit(
    prepared: PreparedRun,
    run: RunPayload,
    result: RunStepResult,
    signal: AbortSignal,
  ): Promise<void> {
    const { git, dataDir } = this.options;
    await writeFile(
      runDirectories(dataDir, prepared.runId).resultFile,
      `${JSON.stringify(result)}\n`,
      { mode: 0o600 },
    );
    const local = this.local(prepared, signal);
    // Review S4 of #154: a merge still open is never committed (`add --all` would mark its
    // conflicted files resolved, markers included). The worker completes or aborts it first.
    const mergeOpen = await git
      .run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD^{commit}'], local)
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof GitCommandError && error.reason === 'exit') return false;
        throw error;
      });
    if (mergeOpen) {
      throw new DeliveryFailedError(
        'A merge is still open in the Working copy, so nothing was committed or pushed. Bring the ' +
          'branch up to date again, or look at the Working copy on the agent side.',
      );
    }
    // Review R2-5: any unmerged path (a cherry-pick, a revert or a stash that conflicted too) is
    // refused for the same reason.
    const unmerged = await git.run(['diff', '--name-only', '--diff-filter=U', '-z'], local);
    if (unmerged.length > 0) {
      throw new DeliveryFailedError(
        'The Working copy has files with unresolved conflicts, so nothing was committed or pushed. ' +
          'Look at the Working copy on the agent side.',
      );
    }
    const status = await git.run(
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      local,
    );
    if (status.length === 0) return;
    const head = await git
      .run(['symbolic-ref', '--quiet', 'HEAD'], local)
      .then((ref) => ref.trim())
      .catch(() => '');
    if (head !== `refs/heads/${prepared.runBranch}`) {
      throw new DeliveryFailedError(
        `The Working copy is not on the Run branch ${prepared.runBranch} and has uncommitted ` +
          'changes, so they cannot be committed. Look at the Working copy on the agent side.',
      );
    }
    await this.gitStep('committing what the agent left', async () => {
      await git.run(['add', '--all'], local);
      const studioPaths = await this.studioPathspecs(prepared, run);
      // Never staged, even if the agent forced them in (an empty list would reset everything).
      if (studioPaths.length > 0) {
        await git.run(['reset', '--quiet', 'HEAD', '--', ...studioPaths], local);
      }
      const staged = await git
        .run(['diff', '--cached', '--quiet'], local)
        .then(() => false)
        .catch((error: unknown) => {
          if (error instanceof GitCommandError && error.exitCode === 1) return true;
          throw error;
        });
      if (!staged) return;
      await git.run(
        [
          'commit',
          '--quiet',
          '--no-verify',
          '--cleanup=whitespace',
          '-m',
          commitMessage(result, run.task),
        ],
        {
          ...local,
          // The Agent account, whatever the agent set in the Working copy's own config.
          config: [
            ['user.name', this.options.agentGitName],
            ['user.email', this.options.agentGitEmail],
            ['commit.gpgSign', 'false'],
          ],
        },
      );
    });
  }

  async deliver(
    prepared: PreparedRun,
    run: RunPayload,
    result: RunStepResult,
    signal: AbortSignal,
  ): Promise<RunDelivery> {
    const { git } = this.options;
    const local = this.local(prepared, signal);
    const branchRef = `refs/heads/${prepared.runBranch}`;
    const range = `${diffBaseOf(prepared)}..${branchRef}`;
    const count = await git
      .run(['rev-list', '--count', range, '--'], local)
      .then((output) => Number.parseInt(output.trim(), 10))
      .catch((error: unknown) => {
        if (error instanceof GitCommandError && error.reason === 'aborted') throw error;
        throw new DeliveryFailedError(
          `The Run branch ${prepared.runBranch} no longer exists in the Working copy.`,
        );
      });
    if (count === 0) return { outcome: 'none' };

    const studioPaths = await this.studioPathspecs(prepared, run);
    if (studioPaths.length > 0) {
      const touched = await git.run(
        ['log', '--no-renames', '--format=', '--name-only', range, '--', ...studioPaths],
        local,
      );
      const path = touched.split('\n').find((line) => line.trim() !== '');
      if (path) {
        throw new DeliveryFailedError(
          `A commit on the Run branch contains ${path.trim()}, a file Studio placed in the ` +
            'Working copy; it is never pushed. Remove it from the Run branch on the agent side, ' +
            'then retry the delivery.',
        );
      }
    }

    const target = parseGitHubRemote(run.repository.remoteUrl, this.options.allowFileRemotes);
    if (!target) {
      throw new DeliveryFailedError(
        'Git host not supported: delivery works only for GitHub repositories. The Run branch stays in the Working copy.',
      );
    }
    const token = this.options.github.token;
    if (!token) {
      throw new DeliveryFailedError(
        'Agent account not configured on the agent worker: set STUDIO_AGENT_GITHUB_TOKEN in ' +
          "the agent worker's .env, restart it, then retry the delivery.",
      );
    }

    const client = (this.options.pullRequests ?? defaultPullRequests)({
      token,
      apiUrl: this.options.github.apiUrl,
    });
    // Issue #141: a Run delivers to at most one pull request. The one Studio recorded must still
    // be open; a merged or closed one stops the delivery before anything is pushed.
    const recorded = run.pullRequestNumber;
    if (recorded !== undefined) {
      const state = await this.pullRequestCall(run, () =>
        client.get({ owner: target.owner, repo: target.repo, number: recorded }, signal),
      );
      if (state.state !== 'open') {
        throw new DeliveryFailedError(
          `The run's pull request #${recorded} is ${state.merged ? 'merged' : 'closed'} on ` +
            'GitHub, so nothing was pushed. Start a new run for further changes.',
        );
      }
    }

    const pushedCommit = await this.push(prepared, run, target.transport, token, signal);

    const content = pullRequestContent(run, prepared, result);
    // Review S7 of #150: only what the agent gave replaces the old text; a title alone keeps the
    // description (whose footer is Studio's).
    const update = result.pullRequest?.body.trim() ? content : { title: content.title };
    const pushed = { branchPushed: true, pushedCommit };
    if (recorded !== undefined) {
      // Repeated delivery: the same pull request; new title and description only when the
      // agent gave them (the footer is always Studio's).
      const state = await this.pullRequestCall(
        run,
        async () => {
          if (result.pullRequest) {
            await client.update(
              { owner: target.owner, repo: target.repo, number: recorded, ...update },
              signal,
            );
          }
          return client.get({ owner: target.owner, repo: target.repo, number: recorded }, signal);
        },
        pushed,
      );
      return {
        outcome: 'delivered',
        pullRequest: { url: state.url, number: state.number },
        pushedCommit,
      };
    }
    const opened = await this.pullRequestCall(
      run,
      async () => {
        const pull = await client.openDraft(
          {
            owner: target.owner,
            repo: target.repo,
            head: prepared.runBranch,
            base: run.integrationBranch,
            ...content,
          },
          signal,
        );
        if (pull.reused && result.pullRequest) {
          await client.update(
            { owner: target.owner, repo: target.repo, number: pull.number, ...update },
            signal,
          );
        }
        return pull;
      },
      pushed,
    );
    return {
      outcome: 'delivered',
      pullRequest: { url: opened.url, number: opened.number },
      pushedCommit,
    };
  }

  /** A pull request call; a refusal becomes a {@link DeliveryFailedError} saying what was pushed. */
  private async pullRequestCall<T>(
    run: RunPayload,
    call: () => Promise<T>,
    pushed?: { branchPushed: boolean; pushedCommit: string },
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof PullRequestFailedError) {
        this.options.logger.error(`Delivery of run ${run.runId}: ${error.message}`);
        throw new DeliveryFailedError(
          error.message,
          pushed?.branchPushed ?? false,
          pushed?.pushedCommit,
        );
      }
      throw error;
    }
  }

  async locate(run: RunPayload): Promise<{ prepared: PreparedRun; result: RunStepResult }> {
    // The Run branch and start commit come from Studio, never from `run.json`, which the agent
    // could rewrite (review R1 of #122).
    if (run.kind !== 'deliver' || run.runBranch === undefined) {
      throw new DeliveryFailedError('Studio sent no recorded Run branch for this delivery.');
    }
    const paths = runDirectories(this.options.dataDir, run.runId);
    const runFile = await readRunFile(paths.runFile);
    const repo = await stat(paths.repoDir).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    if (!runFile || runFile.runId !== run.runId || runFile.projectId !== run.projectId || !repo) {
      throw new DeliveryFailedError(`${NO_WORKING_COPY}: retention or a clean-up removed it.`);
    }
    // Only the recorded Run branch is delivered, from a Working copy that has it checked out.
    if (!(await onBranch(this.options.git, paths.repoDir, run.runBranch, this.options.dataDir))) {
      throw new DeliveryFailedError(
        `The Working copy is not on its Run branch ${run.runBranch}. Look at the Working copy ` +
          'on the agent side, then retry the delivery.',
      );
    }
    const saved = await readFile(paths.resultFile, 'utf8')
      .then((text) => runStepResultSchema.safeParse(JSON.parse(text)))
      .catch(() => null);
    if (!saved?.success || saved.data.outcome !== 'done') {
      throw new DeliveryFailedError(
        "The agent's result for this Run is no longer beside its Working copy, so the pull " +
          'request cannot be written.',
      );
    }
    return {
      prepared: {
        runId: run.runId,
        runDir: paths.runDir,
        repoDir: paths.repoDir,
        runBranch: run.runBranch,
        startCommit: run.startCommit.toLowerCase(),
        ...(run.mergedIntegrationCommit === undefined
          ? {}
          : { diffBase: run.mergedIntegrationCommit }),
        env: { COMPOSE_PROJECT_NAME: composeProjectName(run.runId) },
      },
      result: saved.data,
    };
  }

  /**
   * `git push -- <remote> <Run branch>:<Run branch>`: the one command that leaves the host. It
   * runs in a fresh repository the worker makes beside the Working copy (`push.git`), holding
   * only the Run branch fetched from it: the Working copy's own `.git/config`, which the agent
   * could write (a URL rewrite, a proxy, a credential helper), never applies to the push. An
   * HTTPS push also ignores the agent user's global Git configuration, and its header is scoped
   * to `https://github.com/` (review of #122). `push.git` is made without templates and without
   * any user or system configuration, so nothing the agent wrote there reaches it (review R2).
   * Only a Run branch of this Run is ever pushed, never the integration branch (review R1).
   */
  private async push(
    prepared: PreparedRun,
    run: RunPayload,
    transport: 'https' | 'ssh' | 'file',
    token: string,
    signal: AbortSignal,
  ): Promise<string> {
    const { git, dataDir } = this.options;
    if (!isRunBranchOf(prepared.runBranch, run)) {
      throw new DeliveryFailedError(
        `Refusing to push ${prepared.runBranch}: it is not a Run branch of this Run.`,
      );
    }
    const remoteUrl = run.repository.remoteUrl;
    const ref = `refs/heads/${prepared.runBranch}`;
    const pushDir = posix.join(prepared.runDir, 'push.git');
    const local = { cwd: prepared.runDir, timeoutMs: GIT_TIMEOUTS.local, signal, ceiling: dataDir };
    // No templates and no user config for making and filling push.git (review R2 of #122).
    const isolated = { ...local, userConfig: false as const };
    await rm(pushDir, { recursive: true, force: true });
    let pushedTip = '';
    try {
      await this.gitStep('handing the Run branch to the push', async () => {
        const tip = (
          await git.run(['rev-parse', '--verify', `${ref}^{commit}`], this.local(prepared, signal))
        ).trim();
        await git.run(['init', '--quiet', '--bare', '--template=', pushDir], isolated);
        await git.run(['fetch', '--quiet', '--no-tags', prepared.repoDir, `+${ref}:${ref}`], {
          ...isolated,
          cwd: pushDir,
          transports: ['file'],
        });
        const fetched = (
          await git.run(['rev-parse', '--verify', ref], { ...local, cwd: pushDir })
        ).trim();
        if (fetched !== tip) throw new GitCommandError('fetch', null, 'Run branch moved', 'exit');
        pushedTip = fetched;
      });
      await git.run(['push', '--', remoteUrl, `${ref}:${ref}`], {
        ...local,
        cwd: pushDir,
        timeoutMs: GIT_TIMEOUTS.network,
        transports: this.options.allowFileRemotes ? WORKER_GIT_TRANSPORTS : REMOTE_GIT_TRANSPORTS,
        ...(transport === 'https' ? { userConfig: false as const } : {}),
        config: [
          ['push.followTags', 'false'],
          ['push.gpgSign', 'false'],
          ['push.recurseSubmodules', 'no'],
          // The Agent account for this one HTTPS push only: in the environment, never argv
          // or a config file (coordinator decision on #102), and only for github.com.
          ...(transport === 'https'
            ? [
                [
                  'http.https://github.com/.extraHeader',
                  `Authorization: Basic ${basicCredentials(token)}`,
                ] as const,
              ]
            : []),
        ],
      });
    } catch (error) {
      if (error instanceof DeliveryFailedError) throw error;
      if (!(error instanceof GitCommandError) || error.reason === 'aborted') throw error;
      this.options.logger.error(
        `Delivery of run ${prepared.runId}: ${error.message}: ${error.stderr.trim()}`,
      );
      if (/\[rejected\]|non-fast-forward|fetch first/.test(error.stderr)) {
        throw new DeliveryFailedError(
          `Pushing the Run branch was refused: ${prepared.runBranch} on the remote has commits ` +
            'this Run does not have. Check who else pushed to it (Studio never force-pushes).',
        );
      }
      if (/protected branch|GH006/i.test(error.stderr)) {
        throw new DeliveryFailedError(
          `Pushing the Run branch was refused by branch protection. Check the protection rules ` +
            `that match ${prepared.runBranch}.`,
        );
      }
      throw new DeliveryFailedError(
        `Pushing the Run branch failed (${error.message}). Check that the Agent account can ` +
          'push to the repository (its token or SSH key on the agent worker), branch ' +
          'protection and the network; the agent worker log has the details.',
      );
    } finally {
      await rm(pushDir, { recursive: true, force: true });
    }
    return pushedTip;
  }

  private studioPathspecs(prepared: PreparedRun, run: RunPayload): Promise<string[]> {
    return studioPathspecs(this.options.dataDir, prepared, run);
  }

  private local(prepared: PreparedRun, signal: AbortSignal): GitOptions {
    return {
      cwd: prepared.repoDir,
      timeoutMs: GIT_TIMEOUTS.local,
      signal,
      ceiling: this.options.dataDir,
    };
  }

  /** Runs Git steps; a Git failure becomes a clear {@link DeliveryFailedError}. */
  private async gitStep(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.reason === 'aborted') throw error;
      this.options.logger.error(`Delivery failed while ${what}: ${error.message}: ${error.stderr}`);
      throw new DeliveryFailedError(
        `Delivery failed while ${what} (${error.message}). The agent worker log has the details.`,
      );
    }
  }
}

function defaultPullRequests(github: { token: string; apiUrl: string }): PullRequestClient {
  return new GitHubPullRequests(github);
}

/** `x-access-token:<token>` for HTTP Basic: what GitHub accepts for Git over HTTPS. */
function basicCredentials(token: string): string {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

/** At most `max` characters, never ending in half a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** `agent: <first line of the summary>` (at most 72 characters), then the summary. */
export function commitMessage(result: RunStepResult, task: string): string {
  const headline = firstLine(result.summary) || firstLine(task) || 'Changes made by the agent';
  const subject = `${SUBJECT_PREFIX}${cut(headline, SUBJECT_MAX_LENGTH - SUBJECT_PREFIX.length)}`;
  const summary = result.summary.trim();
  return summary ? `${subject}\n\n${summary}` : subject;
}

const CHECK_LABELS: Record<RunCheck['result'], string> = {
  passed: 'passed',
  failed: 'failed',
  not_run: 'not run',
};

/** A check name on one line, safe inside inline code. */
function checkName(name: string): string {
  return `\`${name.replace(/[`\r\n]+/g, ' ').trim()}\``;
}

/**
 * The pull request's title and description: the agent's own, or a title from the Task and the
 * summary as the description. A plain notice comes first when the agent reported failing
 * checks, and Studio's fixed footer last: the Run, the Provider, the start commit and the
 * agent's account of its checks.
 */
export function pullRequestContent(
  run: RunPayload,
  prepared: PreparedRun,
  result: RunStepResult,
): { title: string; body: string } {
  const title = cut(
    result.pullRequest?.title.trim() || firstLine(run.task) || `Agent run ${run.runId.slice(0, 8)}`,
    TITLE_MAX_LENGTH,
  );
  const checks = result.checks ?? [];
  const failing = checks.filter((check) => check.result === 'failed');
  const notice =
    failing.length > 0
      ? `> **Failing checks:** the agent reported that ${failing.length === 1 ? 'this check' : 'these checks'} failed: ` +
        `${failing
          .slice(0, FOOTER_CHECKS_MAX)
          .map((check) => checkName(check.name))
          .join(', ')}.\n\n`
      : '';
  const listed = checks
    .slice(0, FOOTER_CHECKS_MAX)
    .map((check) => `  - ${CHECK_LABELS[check.result]}: ${checkName(check.name)}`);
  if (checks.length > FOOTER_CHECKS_MAX) {
    listed.push(`  - and ${checks.length - FOOTER_CHECKS_MAX} more`);
  }
  const footer = [
    '',
    '---',
    '',
    '_Delivered by AI Agent Studio._',
    '',
    `- Run: \`${run.runId}\``,
    `- Provider: ${PROVIDER_NAMES[run.provider]}`,
    `- Start commit: \`${prepared.startCommit}\``,
    checks.length > 0 ? '- Checks, as the agent reported them:' : '- Checks: none reported',
    ...listed,
  ].join('\n');
  const room = BODY_MAX_LENGTH - notice.length - footer.length - 1;
  // An empty description from the agent falls back to the summary, like a missing one.
  const description = result.pullRequest?.body.trim() ? result.pullRequest.body : result.summary;
  const shortened = description.length > room ? `${cut(description, room - 2)}\n…` : description;
  return { title, body: `${notice}${shortened.trimEnd()}\n${footer}` };
}
