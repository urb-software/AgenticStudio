import type { Provider } from '@agentic-studio/contracts';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AGENT_RESULT_JSON_SCHEMA } from '../agent-definition/index.js';
import { GIT_TIMEOUTS, GitCommandError, type GitRunner } from '../git.js';
import {
  AgentFailedError,
  type ResumeRunStepInput,
  type Runner,
  type RunStep,
  type RunWorkspace,
  type StartRunStepInput,
} from '../runner.js';
import { errorReason } from '../cli-output.js';
import {
  ManagedGuardrails,
  type ManagedGuardrailsCheck,
  managedGuardrailsFailure,
} from '../managed-guardrails.js';
import { classifyModelFailure, modelOption } from '../model-option.js';
import { ProviderDisabledError } from '../provider-gate.js';
import {
  type ProcessGroupRegistry,
  type ProviderCli,
  signalProcessGroup,
  spawnProviderCli,
} from '../spawn-boundary.js';
import {
  CLAUDE_CODE_MISSING,
  checkClaudeVersion,
  claudeArguments,
  claudeEnvironment,
  claudePrompt,
  claudeStepFiles,
  type VersionCheck,
} from './cli-options.js';
import { prepareRunSettings } from './guardrails.js';
import { agentNotice, buildInstructions, type RepositoryFiles } from './instructions.js';
import {
  parseTreeListing,
  prepareRepoPlugin,
  type RepositoryTree,
  TREE_LISTING_MAX_BYTES,
  TreeListingTooLargeError,
} from './repo-plugin.js';
import { ClaudeStream } from './stream.js';
import { userSettingsProblem } from './user-settings.js';

const PROVIDER: Provider = 'claude_code';

/** Most of the CLI's error output kept for the log of a failed step. */
const STDERR_MAX = 2000;

export interface ClaudeCodeRunnerOptions {
  /** The spawn boundary's inputs: the provider gate and the configured binary. */
  cli: ProviderCli;
  /** Reads the repository's instruction files at the start commit. */
  git: Pick<GitRunner, 'run'>;
  /** The worker's own environment; only the allowlisted variables reach the CLI. */
  env: Record<string, string | undefined>;
  /** The bound on agent turns per Run step (`STUDIO_CLAUDE_MAX_TURNS`). */
  maxTurns: number;
  /** Test seam: where the worker's copies of Studio's guardrails are. */
  guardrails?: { dir?: string };
  /**
   * The check of the root-owned managed guardrails before every step (default: the installed
   * files). Test seam only.
   */
  managed?: ManagedGuardrailsCheck;
  /** Test seam: the per-step code that delimits the repository's instruction blocks. */
  marker?: () => string;
}

/**
 * The Claude Code runner: runs a Run step with the CLI signed in with the operator's subscription,
 * after checking the managed guardrails and writing the instructions and an empty settings file
 * outside the Working copy. Ends `agent_failed` or `usage_limit` (the session is kept to resume).
 */
export class ClaudeCodeRunner implements Runner {
  constructor(private readonly options: ClaudeCodeRunnerOptions) {}

  start(input: StartRunStepInput): RunStep {
    return this.step(input, claudePrompt('task', input.run.task));
  }

  resume(input: ResumeRunStepInput): RunStep {
    return this.step(input, claudePrompt(input.reason, input.answer), input.sessionRef);
  }

  private async *step(input: StartRunStepInput, prompt: string, sessionRef?: string): RunStep {
    const { run, workspace, signal, processes } = input;
    // The dispatcher checked already; nothing is written for a provider that is off.
    this.options.cli.gate.assertEnabled(PROVIDER);
    // A model outside the Provider's list never reaches the CLI, whatever the API sent.
    modelOption(PROVIDER, run.agent.model);
    signal.throwIfAborted();
    // The agent user's own settings still load; refuse what they must not hold.
    const userSettings = await userSettingsProblem(this.options.env.HOME);
    if (userSettings !== null) throw new AgentFailedError(userSettings);
    // Never run without the root-owned managed guardrails.
    const managed = await (this.options.managed ?? new ManagedGuardrails()).problem(PROVIDER);
    if (managed !== null)
      throw new AgentFailedError(managedGuardrailsFailure('Claude Code', managed));
    const files = claudeStepFiles(workspace.runDir);
    await mkdir(files.tmpDir, { recursive: true, mode: 0o700 });
    const marker = this.options.marker?.() ?? randomBytes(6).toString('hex');
    const instructions = await buildInstructions(
      { ...run, agentFolder: workspace.agentFolder ?? null, skills: workspace.skills ?? [] },
      this.repositoryFiles(workspace, run.startCommit, signal),
      marker,
    );
    await writeFile(files.instructionsFile, instructions.text, { mode: 0o600 });
    for (const notice of instructions.notices) yield { type: 'notice', text: notice };
    const plugin = await prepareRepoPlugin(
      files.pluginDir,
      this.repositoryTree(workspace, run.startCommit, signal),
    );
    for (const notice of plugin.notices) yield { type: 'notice', text: notice };
    yield { type: 'notice', text: agentNotice(run) };
    const guardrails = await prepareRunSettings(files.settingsFile, this.options.guardrails?.dir);
    signal.throwIfAborted();
    const args = claudeArguments({
      prompt,
      allowedTools: guardrails.allowedTools,
      settingsFile: guardrails.settingsFile,
      instructionsFile: files.instructionsFile,
      maxTurns: this.options.maxTurns,
      jsonSchema: AGENT_RESULT_JSON_SCHEMA,
      model: run.agent.model,
      ...(plugin.dir === null ? {} : { pluginDir: plugin.dir }),
      ...(sessionRef === undefined ? {} : { sessionRef }),
    });
    const env = claudeEnvironment({
      base: this.options.env,
      tmpDir: files.tmpDir,
      composeProjectName: workspace.env.COMPOSE_PROJECT_NAME,
    });
    return yield* this.execute(args, env, workspace.repoDir, processes, signal, run.agent.model);
  }

  private async *execute(
    args: string[],
    env: Record<string, string>,
    cwd: string,
    processes: ProcessGroupRegistry,
    signal: AbortSignal,
    model: string,
  ): RunStep {
    const child = spawnProviderCli(
      this.options.cli,
      { provider: PROVIDER, args, options: { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] } },
      processes,
    );
    let spawnFailed = false;
    let stderr = '';
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', () => {
        spawnFailed = true;
        resolve(null);
      });
      child.once('close', (code) => resolve(code));
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_MAX);
    });
    const stream = new ClaudeStream();
    if (child.stdout) {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        for (const event of stream.accept(line)) yield event;
      }
    }
    const exitCode = await exited;
    if (signal.aborted) throw signal.reason;
    const outcome = stream.finish({ exitCode, spawnFailed });
    for (const event of outcome.events) yield event;
    if ('result' in outcome) return outcome.result;
    const errorOutput = stderr.trim();
    // A model the CLI refuses ends the Run as such, with the CLI's own line as the reason.
    const fail = (error: Error, detail?: string) =>
      classifyModelFailure(error, model, {
        streamReason: stream.errorText,
        lastErrorLine: errorOutput.split('\n').at(-1),
        detail,
      });
    if (errorOutput === '') throw fail(outcome.error);
    yield { type: 'notice', text: `Claude Code's error output: ${errorOutput}` };
    // The CLI's own reason goes into the failure detail too, so the operator sees it on the Run
    // without opening the log; Studio redacts the detail.
    if (outcome.error instanceof AgentFailedError) {
      throw fail(outcome.error, `${outcome.error.message} ${errorReason(errorOutput)}`);
    }
    throw fail(outcome.error);
  }

  /** The repository's skill and agent folders at the start commit, read from the object store. */
  private repositoryTree(
    workspace: RunWorkspace,
    startCommit: string,
    signal: AbortSignal,
  ): RepositoryTree {
    const options = { cwd: workspace.repoDir, timeoutMs: GIT_TIMEOUTS.local, signal };
    return {
      list: async () => {
        const output = await this.options.git.run(
          ['ls-tree', '-r', '-l', '-z', startCommit, '--', '.claude/skills', '.claude/agents'],
          { ...options, maxStdout: TREE_LISTING_MAX_BYTES },
        );
        // The process runner cuts a longer listing silently.
        if (output.length >= TREE_LISTING_MAX_BYTES) throw new TreeListingTooLargeError();
        return parseTreeListing(output);
      },
      blob: (sha) => this.options.git.run(['cat-file', 'blob', sha], options),
    };
  }

  /** The repository's files at the start commit, read from the Working copy's object store. */
  private repositoryFiles(
    workspace: RunWorkspace,
    startCommit: string,
    signal: AbortSignal,
  ): RepositoryFiles {
    return {
      read: async (path) => {
        try {
          return await this.options.git.run(['cat-file', 'blob', `${startCommit}:${path}`], {
            cwd: workspace.repoDir,
            timeoutMs: GIT_TIMEOUTS.local,
            signal,
          });
        } catch (error) {
          // No such file (or not a file) at the start commit.
          if (error instanceof GitCommandError && error.reason === 'exit') return null;
          throw error;
        }
      },
    };
  }
}

/** Longest wait for `claude --version`. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The version check at worker start: `claude --version` through the spawn boundary with the same
 * minimal environment. A missing binary, no version in time or an unsupported one → the reason.
 */
export async function probeClaudeCode(
  cli: ProviderCli,
  env: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<VersionCheck> {
  // A neutral working directory: an empty temporary one.
  cli.gate.assertEnabled(PROVIDER);
  const cwd = await mkdtemp(join(tmpdir(), 'studio-claude-version-'));
  try {
    return await runProbe(cli, env, cwd, timeoutMs);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function runProbe(
  cli: ProviderCli,
  env: Record<string, string | undefined>,
  cwd: string,
  timeoutMs: number,
): Promise<VersionCheck> {
  return new Promise((resolve) => {
    const groups: number[] = [];
    const registry: ProcessGroupRegistry = { register: (group) => groups.push(group) };
    let child: ReturnType<typeof spawnProviderCli>;
    try {
      child = spawnProviderCli(
        cli,
        {
          provider: PROVIDER,
          args: ['--version'],
          options: {
            cwd,
            env: claudeEnvironment({ base: env }),
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        },
        registry,
      );
    } catch (error) {
      // A switched-off provider is the caller's bug; anything else means it cannot start.
      if (error instanceof ProviderDisabledError) throw error;
      resolve({ ok: false, reason: CLAUDE_CODE_MISSING });
      return;
    }
    let stdout = '';
    let settled = false;
    const settle = (check: VersionCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(check);
    };
    const timer = setTimeout(() => {
      for (const group of groups) signalProcessGroup(group, 'SIGKILL');
      settle(checkClaudeVersion(''));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < 1000) stdout += chunk;
    });
    child.once('error', () => settle({ ok: false, reason: CLAUDE_CODE_MISSING }));
    child.once('close', () => settle(checkClaudeVersion(stdout)));
  });
}
