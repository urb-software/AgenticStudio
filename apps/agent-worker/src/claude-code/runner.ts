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
import { type GuardrailsOptions, prepareGuardrails } from './guardrails.js';
import { buildInstructions, type RepositoryFiles } from './instructions.js';
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
  /** Test seam: where Studio's guardrails are and which Node runs the hook. */
  guardrails?: GuardrailsOptions;
  /** Test seam: the per-step code that delimits the repository's instruction blocks. */
  marker?: () => string;
}

/**
 * The Claude Code runner (Issue #105): runs a Run step with the Claude Code CLI, signed in with
 * the operator's subscription, behind the runner interface. Per step it writes, in the Run's
 * directory and outside the Working copy, the instructions file (the agent definition and the
 * repository's instruction text) and a copy of Studio's guardrail settings and hook, then
 * starts the CLI through the spawn boundary with exactly the compliance record's options, a
 * minimal environment and standard input closed, in the Working copy. It maps the streamed
 * events to the Run's log and ends with the structured result (with the session id), or fails:
 * `agent_failed` (non-zero exit, an error result, no valid structured result) or `usage_limit`
 * (the subscription's limit; the session is kept for a later resume). A stop (cancel, time
 * limit) reaches the CLI through its process group (Issue #100); the session stays on disk.
 */
export class ClaudeCodeRunner implements Runner {
  constructor(private readonly options: ClaudeCodeRunnerOptions) {}

  start(input: StartRunStepInput): RunStep {
    return this.step(input, claudePrompt('task', input.run.task));
  }

  resume(input: ResumeRunStepInput): RunStep {
    return this.step(input, claudePrompt('answer', input.answer), input.sessionRef);
  }

  private async *step(input: StartRunStepInput, prompt: string, sessionRef?: string): RunStep {
    const { run, workspace, signal, processes, agentDefinition } = input;
    // The dispatcher checked already; nothing is written for a provider that is off.
    this.options.cli.gate.assertEnabled(PROVIDER);
    signal.throwIfAborted();
    // Review R4 of #129: the agent user's own settings still load; refuse what they must not hold.
    const userSettings = await userSettingsProblem(this.options.env.HOME);
    if (userSettings !== null) throw new AgentFailedError(userSettings);
    const files = claudeStepFiles(workspace.runDir);
    await mkdir(files.tmpDir, { recursive: true, mode: 0o700 });
    const marker = this.options.marker?.() ?? randomBytes(6).toString('hex');
    const instructions = await buildInstructions(
      agentDefinition,
      this.repositoryFiles(workspace, run.startCommit, signal),
      marker,
    );
    await writeFile(files.instructionsFile, instructions.text, { mode: 0o600 });
    for (const notice of instructions.notices) yield { type: 'notice', text: notice };
    const guardrails = await prepareGuardrails(files, this.options.guardrails);
    signal.throwIfAborted();
    const args = claudeArguments({
      prompt,
      allowedTools: guardrails.allowedTools,
      settingsFile: guardrails.settingsFile,
      instructionsFile: files.instructionsFile,
      maxTurns: this.options.maxTurns,
      jsonSchema: AGENT_RESULT_JSON_SCHEMA,
      ...(sessionRef === undefined ? {} : { sessionRef }),
    });
    const env = claudeEnvironment({
      base: this.options.env,
      tmpDir: files.tmpDir,
      composeProjectName: workspace.env.COMPOSE_PROJECT_NAME,
    });
    return yield* this.execute(args, env, workspace.repoDir, processes, signal);
  }

  private async *execute(
    args: string[],
    env: Record<string, string>,
    cwd: string,
    processes: ProcessGroupRegistry,
    signal: AbortSignal,
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
    if (errorOutput === '') throw outcome.error;
    yield { type: 'notice', text: `Claude Code's error output: ${errorOutput}` };
    // The CLI's own reason (e.g. a refused option) goes into the failure detail as well, so the
    // operator sees it on the Run without opening the log; Studio redacts the detail (#104).
    if (outcome.error instanceof AgentFailedError) {
      throw new AgentFailedError(`${outcome.error.message} ${errorReason(errorOutput)}`);
    }
    throw outcome.error;
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

/** Longest CLI reason taken into a failure detail. */
const REASON_MAX = 500;

/** "Its error output: <last line of standard error>", cut to {@link REASON_MAX} characters. */
export function errorReason(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  const reason = last.length > REASON_MAX ? `${last.slice(0, REASON_MAX - 1)}…` : last;
  return `Its error output: ${reason}`;
}

/** Longest wait for `claude --version`. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The version check at worker start (Issue #105): `claude --version` through the spawn
 * boundary (no session is started), with the same minimal environment and standard input
 * closed, checked against the supported range. A missing binary, no version within the time
 * limit or an unsupported version → the reason the provider is unavailable.
 */
export async function probeClaudeCode(
  cli: ProviderCli,
  env: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<VersionCheck> {
  // A neutral working directory: an empty temporary one (review R3 of #129).
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
