import type { ResumeReason } from '@agentic-studio/contracts';
import { posix } from 'node:path';
import {
  PROVIDER_PASSED_VARIABLES,
  type ProviderEnvironmentInput,
  providerEnvironment,
} from '../provider-environment.js';

/**
 * How the worker starts the Claude Code CLI: exactly the options of the approved compliance record
 * (docs/engineering/provider-compliance/), a minimal environment, a supported version range;
 * changing any of them needs revalidation by the operator.
 */

/** The supported CLI versions: tested with 2.1.325; `--permission-prompts` needs 2.1.259. */
export const CLAUDE_CODE_VERSIONS = {
  /** Lowest supported version (inclusive). */
  min: [2, 1, 325],
  /** First unsupported version (exclusive). */
  below: [2, 2, 0],
  label: '>=2.1.325 <2.2.0',
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

/** What `claude --version` printed, checked against {@link CLAUDE_CODE_VERSIONS}. */
export function checkClaudeVersion(output: string): VersionCheck {
  const match = /^\s*(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[\s(]|$)/.exec(output);
  if (!match) {
    return {
      ok: false,
      reason:
        'The Claude Code CLI did not report a version it could be checked by. Install a ' +
        `supported version (${CLAUDE_CODE_VERSIONS.label}) and restart the worker.`,
    };
  }
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const text = version.join('.');
  if (
    compare(version, CLAUDE_CODE_VERSIONS.min) < 0 ||
    compare(version, CLAUDE_CODE_VERSIONS.below) >= 0
  ) {
    return {
      ok: false,
      reason:
        `Claude Code ${text} is not a supported version (supported: ` +
        `${CLAUDE_CODE_VERSIONS.label}). Install a supported version and restart the worker.`,
    };
  }
  return { ok: true, version: text };
}

/** The reason when the CLI binary could not be started at all. */
export const CLAUDE_CODE_MISSING =
  'The Claude Code CLI could not be started (CLAUDE_CODE_BIN). Install it for the agent user ' +
  'and restart the worker.';

/**
 * The only worker variables a Claude Code process gets ({@link PROVIDER_PASSED_VARIABLES}); the
 * rest is dropped: API keys, auth tokens and `CLAUDE_CODE_USE_*` would override the subscription
 * login, and the worker and Agent account tokens must never reach the agent.
 */
export const CLAUDE_CODE_PASSED_VARIABLES = PROVIDER_PASSED_VARIABLES;

export type ClaudeEnvironmentInput = ProviderEnvironmentInput;

/**
 * The complete environment of a Claude Code process: the allowlisted variables of the worker's
 * environment (`DOCKER_HOST` only when it is not the system daemon's socket), `TERM=dumb`, the
 * Run step's `TMPDIR` and the Run's `COMPOSE_PROJECT_NAME`.
 */
export function claudeEnvironment(input: ClaudeEnvironmentInput): Record<string, string> {
  return providerEnvironment(input);
}

export interface ClaudeArgumentsInput {
  /** The step's message to the agent: the Task, or the operator's answer. */
  prompt: string;
  /** Studio's allowed tool rules (from its guardrail settings file). */
  allowedTools: readonly string[];
  /** The per-Run settings file in the Run's directory (`{}`: the guardrails are managed). */
  settingsFile: string;
  /** The agent definition and the repository's instruction text, in the Run's directory. */
  instructionsFile: string;
  /** The bound on agent turns (`STUDIO_CLAUDE_MAX_TURNS`). */
  maxTurns: number;
  /** The structured result's JSON Schema, as JSON. */
  jsonSchema: string;
  /** A resumed step: the session to continue. */
  sessionRef?: string;
  /** The sanitized plugin of the repository's skills and subagents; absent when it is empty. */
  pluginDir?: string;
}

/**
 * The CLI's arguments, exactly the record's Mode: non-interactive, prompts disabled (anything that
 * would prompt is denied), only the user's setting source (no project settings, hooks or MCP).
 * Never `--bare`: it does not read the subscription login.
 */
export function claudeArguments(input: ClaudeArgumentsInput): string[] {
  return [
    '-p',
    input.prompt,
    ...(input.sessionRef === undefined ? [] : ['--resume', input.sessionRef]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--allowedTools',
    input.allowedTools.join(','),
    '--setting-sources',
    'user',
    '--settings',
    input.settingsFile,
    '--strict-mcp-config',
    '--max-turns',
    String(input.maxTurns),
    '--append-system-prompt-file',
    input.instructionsFile,
    '--json-schema',
    input.jsonSchema,
    ...(input.pluginDir === undefined ? [] : ['--plugin-dir', input.pluginDir]),
  ];
}

/**
 * The step's message to the agent. A heading first, so the text never starts with `-` (the CLI
 * would read it as an option) and the agent can tell the Task from an answer.
 */
export function claudePrompt(kind: 'task' | ResumeReason, text: string): string {
  if (kind === 'task') return `The operator's Task:\n\n${text}`;
  if (kind === 'follow_up') return `The operator's Follow-up:\n\n${text}`;
  if (kind === 'bring_up_to_date') {
    return `Studio's instruction to bring the branch up to date:\n\n${text}`;
  }
  return `The operator's answer:\n\n${text}`;
}

/** The files a Claude Code step uses in the Run's directory (outside the Working copy). */
export function claudeStepFiles(runDir: string) {
  return {
    settingsFile: posix.join(runDir, 'claude-settings.json'),
    instructionsFile: posix.join(runDir, 'instructions.md'),
    pluginDir: posix.join(runDir, 'repo-plugin'),
    tmpDir: posix.join(runDir, 'tmp'),
  };
}
