import type { ResumeReason } from '@agentic-studio/contracts';
import { posix } from 'node:path';
import { modelOption } from '../model-option.js';
import {
  PROVIDER_PASSED_VARIABLES,
  type ProviderEnvironmentInput,
  providerEnvironment,
} from '../provider-environment.js';

/**
 * How the worker starts the Codex CLI: exactly the command of the approved compliance record
 * (docs/engineering/provider-compliance/), a minimal environment, a supported version range;
 * changing any of them needs revalidation by the operator.
 */

/** The supported CLI versions: tested with 0.169.0 (record, headless test of 2026-11-15). */
export const CODEX_VERSIONS = {
  /** Lowest supported version (inclusive). */
  min: [0, 169, 0],
  /** First unsupported version (exclusive). */
  below: [0, 180, 0],
  label: '>=0.169.0 <0.180.0',
} as const;

type Version = readonly [number, number, number];

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/** The outcome of the version check at worker start. */
export type VersionCheck = { ok: true; version: string } | { ok: false; reason: string };

/** What `codex --version` printed (`codex-cli 0.169.0`), checked against {@link CODEX_VERSIONS}. */
export function checkCodexVersion(output: string): VersionCheck {
  const match = /^\s*(?:codex(?:-cli)?\s+)?v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[\s(]|$)/.exec(
    output,
  );
  if (!match) {
    return {
      ok: false,
      reason:
        'The Codex CLI did not report a version it could be checked by. Install a supported ' +
        `version (${CODEX_VERSIONS.label}) and restart the worker.`,
    };
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const text = version.join('.');
  if (compare(version, CODEX_VERSIONS.min) < 0 || compare(version, CODEX_VERSIONS.below) >= 0) {
    return {
      ok: false,
      reason:
        `Codex ${text} is not a supported version (supported: ${CODEX_VERSIONS.label}). ` +
        'Install a supported version and restart the worker.',
    };
  }
  return { ok: true, version: text };
}

/** The reason when the CLI binary could not be started at all. */
export const CODEX_MISSING =
  'The Codex CLI could not be started (CODEX_CLI_BIN). Install it for the agent user with the ' +
  'official standalone installer and restart the worker.';

/**
 * The accepted Codex sandbox modes (`STUDIO_CODEX_SANDBOX`): only `workspace-write` (ADR 0002 keeps
 * the sandbox, network on); any other value is refused at start.
 */
export const CODEX_SANDBOX_MODES = ['workspace-write'] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** How the Run's log states the sandbox mode in force, at the start of every Codex Run step. */
export function sandboxNotice(mode: CodexSandboxMode): string {
  return `Codex sandbox: ${mode}, network on (set by the agent worker's configuration).`;
}

/**
 * The worker variables a Codex process gets ({@link PROVIDER_PASSED_VARIABLES}); the rest is
 * dropped: `OPENAI_*`/`CODEX_*` overrides (also `CODEX_HOME`) and the worker's and Studio's tokens.
 */
export const CODEX_PASSED_VARIABLES = PROVIDER_PASSED_VARIABLES;

/** The complete environment of a Codex process (see {@link providerEnvironment}). */
export function codexEnvironment(input: ProviderEnvironmentInput): Record<string, string> {
  return providerEnvironment(input);
}

/** The files a Codex step uses in the Run's directory (outside the Working copy). */
export function codexStepFiles(runDir: string) {
  const dir = posix.join(runDir, 'codex');
  return {
    dir,
    /** The structured result's JSON Schema (`--output-schema`). */
    schemaFile: posix.join(dir, 'result.schema.json'),
    /** The agent's final message of a first step (`--output-last-message`). */
    resultFile: posix.join(dir, 'result.json'),
    /** Standard input of a first step: the agent definition and the Task. */
    promptFile: posix.join(dir, 'prompt.md'),
    /** Standard input of a resumed step: the operator's answer. */
    answerFile: posix.join(dir, 'answer.md'),
    tmpDir: posix.join(runDir, 'tmp'),
  };
}

/** The options both steps start with: exactly the record's. */
function common(workingCopy: string, sandbox: CodexSandboxMode): string[] {
  return [
    'exec',
    '--json',
    '--cd',
    workingCopy,
    '--sandbox',
    sandbox,
    '-c',
    'approval_policy="never"',
  ];
}

export interface CodexArgumentsInput {
  workingCopy: string;
  sandbox: CodexSandboxMode;
  files: ReturnType<typeof codexStepFiles>;
  /** The Run's recorded model: a value of the Provider's list; `default` adds no option. */
  model?: string;
}

/**
 * A first step, exactly the record's command, the prompt on standard input. Never `--ephemeral`
 * (resume needs the session files), `--skip-git-repo-check`, `--dangerously-*` or
 * `--approve-for-me`.
 */
export function codexStartArguments(input: CodexArgumentsInput): string[] {
  return [
    ...common(input.workingCopy, input.sandbox),
    ...modelOption('codex', input.model),
    '--output-schema',
    input.files.schemaFile,
    '--output-last-message',
    input.files.resultFile,
    '-',
  ];
}

/**
 * A resumed step, exactly the record's command, the answer on standard input. No schema option
 * (the record shows none for `resume`): the result is the last agent message.
 */
export function codexResumeArguments(
  input: CodexArgumentsInput & { sessionRef: string },
): string[] {
  return [
    ...common(input.workingCopy, input.sandbox),
    ...modelOption('codex', input.model),
    'resume',
    input.sessionRef,
    '-',
  ];
}

/**
 * What the Codex agent is told on top of the agent definition: its sandbox keeps `.git` read-only,
 * so it cannot commit; Studio commits and delivers its work.
 */
export const CODEX_DELIVERY_NOTE = `## Commits and delivery (Codex)

You cannot commit: the sandbox keeps .git read-only. Do not try to commit, push, or change Git
configuration. Leave your changes in the working copy; when the step ends done, AI Agent Studio
commits them on the Run branch and opens the pull request with your "pullRequest" title and body.
`;

/**
 * Standard input of a first step: the instructions (the agent definition, then the repository's
 * AGENTS.md text in its delimited untrusted block, if any), the Codex note and the Task.
 */
export function codexPrompt(instructions: string, task: string): string {
  return `${instructions.trimEnd()}\n\n${CODEX_DELIVERY_NOTE}\n# The operator's Task\n\n${task}\n`;
}

/** Standard input of a resumed step: the operator's answer or a further instruction. */
export function codexAnswer(answer: string, reason: ResumeReason = 'answer'): string {
  if (reason === 'follow_up') return `The operator's Follow-up:\n\n${answer}\n`;
  if (reason === 'bring_up_to_date') {
    return `Studio's instruction to bring the branch up to date:\n\n${answer}\n`;
  }
  return `The operator's answer:\n\n${answer}\n`;
}
