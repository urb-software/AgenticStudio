import type { Provider } from '@agentic-studio/contracts';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { AGENT_RESULT_JSON_SCHEMA } from '../agent-definition/index.js';
import { errorReason } from '../cli-output.js';
import { ProviderDisabledError } from '../provider-gate.js';
import {
  AgentFailedError,
  type ResumeRunStepInput,
  type Runner,
  type RunStep,
  type StartRunStepInput,
} from '../runner.js';
import {
  type ProcessGroupRegistry,
  type ProviderCli,
  signalProcessGroup,
  spawnProviderCli,
} from '../spawn-boundary.js';
import {
  CODEX_MISSING,
  type CodexSandboxMode,
  checkCodexVersion,
  codexAnswer,
  codexEnvironment,
  codexPrompt,
  codexResumeArguments,
  codexStartArguments,
  codexStepFiles,
  sandboxNotice,
  type VersionCheck,
} from './cli-options.js';
import { prepareCodexHome } from './codex-home.js';
import { codexInstallProblem } from './install-check.js';
import { CodexStream, type ResultSource } from './stream.js';

const PROVIDER: Provider = 'codex';

/** Most of the CLI's error output kept for the log of a failed step. */
const STDERR_MAX = 2000;

export interface CodexRunnerOptions {
  /** The spawn boundary's inputs: the provider gate and the configured binary. */
  cli: ProviderCli;
  /** The worker's own environment; only the allowlisted variables reach the CLI. */
  env: Record<string, string | undefined>;
  /** The sandbox mode in force (`STUDIO_CODEX_SANDBOX`). */
  sandbox: CodexSandboxMode;
  /** The worker's data directory: every Working copy under it is marked untrusted. */
  dataDir?: string;
  /** Test seam: where Studio's templates are and which Node runs the hook. */
  guardrails?: { dir?: string; nodePath?: string };
}

/**
 * The Codex runner (Issue #106): runs a Run step with the Codex CLI, signed in with the
 * operator's ChatGPT plan, behind the runner interface. Per step it states the sandbox mode in
 * the Run's log, rewrites Studio's Codex configuration in the agent user's Codex home (the
 * Working copies marked untrusted, Studio's hook and rules), writes the step's files in the
 * Run's directory (outside the Working copy), then starts the CLI through the spawn boundary
 * with exactly the compliance record's command, a minimal environment and standard input read
 * from a file, in the Working copy. It maps the streamed events to the Run's log and ends with
 * the structured result (with the session id from the stream), or fails: `agent_failed` or
 * `usage_limit` (the session is kept for a later resume). A stop reaches the CLI through its
 * process group (Issue #100); the session files stay in the Codex home.
 */
export class CodexRunner implements Runner {
  constructor(private readonly options: CodexRunnerOptions) {}

  start(input: StartRunStepInput): RunStep {
    return this.step(input);
  }

  resume(input: ResumeRunStepInput): RunStep {
    return this.step(input, input);
  }

  private async *step(
    input: StartRunStepInput,
    resumed?: { answer: string; sessionRef: string },
  ): RunStep {
    const { run, workspace, signal, processes, agentDefinition } = input;
    // The dispatcher checked already; nothing is written for a provider that is off.
    this.options.cli.gate.assertEnabled(PROVIDER);
    signal.throwIfAborted();
    const home = this.options.env.HOME;
    if (!home || !isAbsolute(home)) {
      throw new AgentFailedError(
        "Codex needs the agent user's home directory (HOME) on the agent worker.",
      );
    }
    yield { type: 'notice', text: sandboxNotice(this.options.sandbox) };
    await prepareCodexHome(
      {
        home,
        ...(this.options.dataDir === undefined ? {} : { dataDir: this.options.dataDir }),
        ...(this.options.guardrails?.dir === undefined
          ? {}
          : { guardrailsDir: this.options.guardrails.dir }),
        ...(this.options.guardrails?.nodePath === undefined
          ? {}
          : { nodePath: this.options.guardrails.nodePath }),
      },
      [workspace.repoDir],
    );
    const files = codexStepFiles(workspace.runDir);
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    await mkdir(files.tmpDir, { recursive: true, mode: 0o700 });
    let args: string[];
    let stdinFile: string;
    if (resumed === undefined) {
      await writeFile(files.schemaFile, AGENT_RESULT_JSON_SCHEMA, { mode: 0o600 });
      await rm(files.resultFile, { force: true });
      await writeFile(files.promptFile, codexPrompt(agentDefinition.text, run.task), {
        mode: 0o600,
      });
      args = codexStartArguments({
        workingCopy: workspace.repoDir,
        sandbox: this.options.sandbox,
        files,
      });
      stdinFile = files.promptFile;
    } else {
      await writeFile(files.answerFile, codexAnswer(resumed.answer), { mode: 0o600 });
      args = codexResumeArguments({
        workingCopy: workspace.repoDir,
        sandbox: this.options.sandbox,
        files,
        sessionRef: resumed.sessionRef,
      });
      stdinFile = files.answerFile;
    }
    signal.throwIfAborted();
    const env = codexEnvironment({
      base: this.options.env,
      tmpDir: files.tmpDir,
      ...(workspace.env.COMPOSE_PROJECT_NAME
        ? { composeProjectName: workspace.env.COMPOSE_PROJECT_NAME }
        : {}),
    });
    const source = async (): Promise<ResultSource> =>
      resumed === undefined
        ? { kind: 'file', text: await readFile(files.resultFile, 'utf8').catch(() => undefined) }
        : { kind: 'last-message' };
    const stream = new CodexStream(resumed?.sessionRef);
    return yield* this.execute(args, env, workspace.repoDir, stdinFile, processes, signal, {
      stream,
      source,
    });
  }

  private async *execute(
    args: string[],
    env: Record<string, string>,
    cwd: string,
    stdinFile: string,
    processes: ProcessGroupRegistry,
    signal: AbortSignal,
    { stream, source }: { stream: CodexStream; source: () => Promise<ResultSource> },
  ): RunStep {
    // Record, finding 8: standard input is a file, so it ends; it is never left open.
    const stdin = openSync(stdinFile, 'r');
    let child: ReturnType<typeof spawnProviderCli>;
    try {
      child = spawnProviderCli(
        this.options.cli,
        { provider: PROVIDER, args, options: { cwd, env, stdio: [stdin, 'pipe', 'pipe'] } },
        processes,
      );
    } finally {
      // The child has its own copy of the descriptor. Closed synchronously: nothing may run
      // between the spawn and reading its output.
      closeSync(stdin);
    }
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
    if (child.stdout) {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        for (const event of stream.accept(line)) yield event;
      }
    }
    const exitCode = await exited;
    if (signal.aborted) throw signal.reason;
    const outcome = stream.finish({ exitCode, spawnFailed }, await source());
    for (const event of outcome.events) yield event;
    if ('result' in outcome) return outcome.result;
    const errorOutput = stderr.trim();
    if (errorOutput === '') throw outcome.error;
    yield { type: 'notice', text: `Codex's error output: ${errorOutput}` };
    if (outcome.error instanceof AgentFailedError) {
      throw new AgentFailedError(`${outcome.error.message} ${errorReason(errorOutput)}`);
    }
    throw outcome.error;
  }
}

/** Longest wait for `codex --version`. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The checks at worker start (Issue #106): a complete standalone install (record, finding 7),
 * then `codex --version` through the spawn boundary (no session is started), with the minimal
 * environment, standard input closed and an empty temporary working directory, checked against
 * the supported range. Otherwise the reason the provider is unavailable.
 */
export async function probeCodex(
  cli: ProviderCli,
  env: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<VersionCheck> {
  cli.gate.assertEnabled(PROVIDER);
  const problem = await codexInstallProblem(cli.binaries.codex, env, CODEX_MISSING);
  if (problem !== null) return { ok: false, reason: problem };
  const cwd = await mkdtemp(join(tmpdir(), 'studio-codex-version-'));
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
            env: codexEnvironment({ base: env }),
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        },
        registry,
      );
    } catch (error) {
      if (error instanceof ProviderDisabledError) throw error;
      resolve({ ok: false, reason: CODEX_MISSING });
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
      settle(checkCodexVersion(''));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < 1000) stdout += chunk;
    });
    child.once('error', () => settle({ ok: false, reason: CODEX_MISSING }));
    child.once('close', () => settle(checkCodexVersion(stdout)));
  });
}
