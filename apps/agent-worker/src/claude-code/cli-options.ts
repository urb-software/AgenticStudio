import { posix } from 'node:path';

/**
 * How the agent worker starts the Claude Code CLI (Issue #105): exactly the options of the
 * approved compliance record's Mode (docs/engineering/provider-compliance/
 * 2026-11-14-claude-code-cli.md, revised 2026-11-16), a minimal environment and a supported
 * version range. Changing any of them is a revalidation trigger of the record and needs the
 * operator.
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
  if (compare(version, CLAUDE_CODE_VERSIONS.min) < 0 || compare(version, CLAUDE_CODE_VERSIONS.below) >= 0) {
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
 * The only variables of the worker's environment a Claude Code process gets (coordinator
 * decision on #105). Everything else is dropped, in particular `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, every
 * `CLAUDE_CODE_USE_*` (they would override the subscription login: compliance record, technical
 * finding 5) and all of Studio's and the worker's own settings (the worker token, the Agent
 * account's token).
 */
export const CLAUDE_CODE_PASSED_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'XDG_RUNTIME_DIR',
  'DOCKER_HOST',
] as const;

/** The system Docker daemon's sockets: never handed to an agent as its `DOCKER_HOST`. */
const SYSTEM_DOCKER_HOSTS = ['unix:///var/run/docker.sock', 'unix:///run/docker.sock'];

export interface ClaudeEnvironmentInput {
  /** The worker's own environment, filtered here. */
  base: Record<string, string | undefined>;
  /** The Run step's temporary directory, inside the Run's directory (none for the version check). */
  tmpDir?: string;
  /** The Run's Compose project name (`COMPOSE_PROJECT_NAME`), when it has one. */
  composeProjectName?: string;
}

/**
 * The complete environment of a Claude Code process: the allowlisted variables of the worker's
 * environment (`DOCKER_HOST` only when it is not the system daemon's socket), `TERM=dumb`, the
 * Run step's `TMPDIR` and the Run's `COMPOSE_PROJECT_NAME`.
 */
export function claudeEnvironment(input: ClaudeEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CLAUDE_CODE_PASSED_VARIABLES) {
    const value = input.base[name];
    if (value === undefined || value === '') continue;
    if (name === 'DOCKER_HOST' && SYSTEM_DOCKER_HOSTS.includes(value.replace(/\/+$/, ''))) {
      continue;
    }
    env[name] = value;
  }
  env.TERM = 'dumb';
  if (input.tmpDir) env.TMPDIR = input.tmpDir;
  if (input.composeProjectName) env.COMPOSE_PROJECT_NAME = input.composeProjectName;
  return env;
}

export interface ClaudeArgumentsInput {
  /** The step's message to the agent: the Task, or the operator's answer. */
  prompt: string;
  /** Studio's allowed tool rules (from its guardrail settings file). */
  allowedTools: readonly string[];
  /** Studio's guardrail settings in the Run's directory. */
  settingsFile: string;
  /** The agent definition and the repository's instruction text, in the Run's directory. */
  instructionsFile: string;
  /** The bound on agent turns (`STUDIO_CLAUDE_MAX_TURNS`). */
  maxTurns: number;
  /** The structured result's JSON Schema, as JSON. */
  jsonSchema: string;
  /** A resumed step: the session to continue. */
  sessionRef?: string;
}

/**
 * The CLI's arguments, exactly the record's Mode (revised 2026-11-16): a non-interactive step
 * with streamed JSON events, prompts disabled (anything that would prompt is denied), Studio's
 * allowed tools and guardrail settings, only the user's own setting source (no project settings,
 * hooks or `.mcp.json`), no MCP configuration but Studio's (none), a bound on turns, Studio's
 * instructions file and the structured result's schema. A resumed step adds `--resume`. Never
 * `--bare`: bare mode does not read the subscription login.
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
  ];
}

/**
 * The step's message to the agent. A heading first, so the text never starts with `-` (the CLI
 * would read it as an option) and the agent can tell the Task from an answer.
 */
export function claudePrompt(kind: 'task' | 'answer', text: string): string {
  return kind === 'task' ? `The operator's Task:\n\n${text}` : `The operator's answer:\n\n${text}`;
}

/** The files a Claude Code step uses in the Run's directory (outside the Working copy). */
export function claudeStepFiles(runDir: string) {
  return {
    settingsFile: posix.join(runDir, 'claude-settings.json'),
    guardScript: posix.join(runDir, 'claude-guard.mjs'),
    instructionsFile: posix.join(runDir, 'instructions.md'),
    tmpDir: posix.join(runDir, 'tmp'),
  };
}
