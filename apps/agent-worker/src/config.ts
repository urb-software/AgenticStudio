import {
  type Provider,
  type ProviderSwitches,
  WORKER_RUNNER_MODES,
  type WorkerRunnerMode,
} from '@agentic-studio/contracts';
import { z } from 'zod';
import { readProviderSwitches } from './provider-gate.js';
import type { ProviderBinaries } from './spawn-boundary.js';

/** The GitHub REST API the worker opens pull requests through by default (Issue #102). */
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

/** Shortest accepted worker token; the API applies the same rule (Issue #96). */
export const WORKER_TOKEN_MIN_LENGTH = 32;

/** Where the worker is deployed; it decides whether the fake runner is allowed (Issue #101). */
export const WORKER_ENVIRONMENTS = ['production', 'development', 'test'] as const;
export type WorkerEnvironment = (typeof WORKER_ENVIRONMENTS)[number];

/**
 * The provider CLI binaries the spawn boundary starts (review of #116): a command name looked up
 * on PATH, or an absolute path. Never a relative path (it would depend on the working directory)
 * and never arguments or shell syntax.
 */
export const PROVIDER_BINARY_VARIABLES = {
  claude_code: 'CLAUDE_CODE_BIN',
  codex: 'CODEX_CLI_BIN',
} as const satisfies Record<Provider, string>;
export const DEFAULT_PROVIDER_BINARIES = {
  claude_code: 'claude',
  codex: 'codex',
} as const satisfies Record<Provider, string>;

const binary = (fallback: string) =>
  z
    .string()
    .regex(/^(?:[A-Za-z0-9._-]+|\/[^\0\r\n]+)$/, {
      message: 'must be a command name or an absolute path',
    })
    .refine((value) => value !== '.' && value !== '..', {
      message: 'must be a command name or an absolute path',
    })
    .default(fallback);

const intervalMs = (fallback: number) =>
  z.coerce.number().int().min(100).max(600_000).default(fallback);

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const environmentSchema = z.object({
  // Where the worker reaches the Studio API (it always calls Studio; nothing calls it).
  STUDIO_API_URL: z.url({ protocol: /^https?$/, error: 'is required: the Studio API URL' }),
  // Messages never echo the token.
  STUDIO_WORKER_TOKEN: z
    .string({ error: `is required: at least ${WORKER_TOKEN_MIN_LENGTH} characters` })
    .refine((value) => value.length >= WORKER_TOKEN_MIN_LENGTH, {
      message: `must be at least ${WORKER_TOKEN_MIN_LENGTH} characters`,
    }),
  STUDIO_WORKER_POLL_MS: intervalMs(5000),
  STUDIO_WORKER_HEARTBEAT_MS: intervalMs(10_000),
  // Longest wait for one call to the Studio API before it is abandoned.
  STUDIO_WORKER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  // How Runs are carried out (Issue #101): the provider CLI, or the scripted fake runner.
  STUDIO_WORKER_RUNNER: z.enum(WORKER_RUNNER_MODES).default('cli'),
  // Production unless said otherwise; only development and test allow the fake runner and a
  // local (file) remote for a Run (Issue #98).
  STUDIO_WORKER_ENVIRONMENT: z.enum(WORKER_ENVIRONMENTS).default('production'),
  CLAUDE_CODE_BIN: binary(DEFAULT_PROVIDER_BINARIES.claude_code),
  CODEX_CLI_BIN: binary(DEFAULT_PROVIDER_BINARIES.codex),
  // Issue #98: where the worker keeps the per-project caches and the Runs' directories.
  STUDIO_WORKER_DATA_DIR: z
    .string({ error: 'is required: an absolute directory path' })
    .refine((value) => value.startsWith('/'), { message: 'must be an absolute path' })
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => value !== '', { message: 'must not be the root directory' }),
  // The Agent account's Git identity for commits in Working copies (never a credential).
  STUDIO_AGENT_GIT_NAME: z
    .string({ error: "is required: the Agent account's name for commits" })
    .min(1)
    .max(200)
    .refine((value) => !CONTROL_CHARACTERS.test(value) && !/[<>]/.test(value), {
      message: 'must be one line without < or >',
    }),
  STUDIO_AGENT_GIT_EMAIL: z
    .string({ error: "is required: the Agent account's email for commits" })
    .max(320)
    .regex(/^[^\s<>@]+@[^\s<>@]+$/, { message: 'must be an email address' }),
  // Retention of finished Working copies.
  STUDIO_WORKER_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  STUDIO_WORKER_RETENTION_MAX_PER_PROJECT: z.coerce.number().int().min(0).max(1000).default(10),
  // Issue #100: how long a stopped Run step's processes get after the interrupt (SIGINT)
  // before the worker kills their whole process group (SIGKILL).
  STUDIO_WORKER_KILL_GRACE_SECONDS: z.coerce.number().int().min(1).max(300).default(10),
  // Issue #102: the Agent account's GitHub token, from the worker's own .env only (Studio stores
  // none). Printable ASCII without spaces, so it can never inject a header. Empty means unset.
  // Messages never echo it.
  STUDIO_AGENT_GITHUB_TOKEN: z
    .string()
    .max(1000, { message: 'must be at most 1000 characters' })
    .refine((value) => value === '' || /^[!-~]+$/.test(value), {
      message: 'must be one token without spaces or control characters',
    })
    .optional(),
  // Where the worker opens pull requests; tests point it at a stub.
  STUDIO_AGENT_GITHUB_API_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
    .default(DEFAULT_GITHUB_API_URL),
});

/**
 * Studio-side settings that must never reach the agent worker (ADR 0002, review of #112): it
 * holds no database, Redis, secret-store or operator credentials. If any is present in its
 * environment (e.g. Studio's root .env was loaded), the worker refuses to start.
 */
export const STUDIO_SIDE_VARIABLES = [
  'DATABASE_URL',
  'REDIS_URL',
  'STUDIO_SECRETS_KEY',
  'STUDIO_OPERATOR_PASSWORD_HASH',
  'POSTGRES_PASSWORD',
] as const;

export interface WorkerConfig {
  /** Base URL of the Studio API, without a trailing slash (e.g. `http://127.0.0.1:3001`). */
  apiUrl: string;
  /** Sent as `Authorization: Bearer`; never logged. */
  token: string;
  /** Pause between two claims when there is no work. */
  pollMs: number;
  /** Interval of heartbeats while the worker carries a Run. */
  heartbeatMs: number;
  /** Timeout of one call to the Studio API. */
  requestTimeoutMs: number;
  /** `cli` (default) or `fake`; `fake` only in a development or test environment. */
  runner: WorkerRunnerMode;
  /** Also decides whether a Run's remote may be a local path (development and test only). */
  environment: WorkerEnvironment;
  /** The operator's provider switches, read once (`CLAUDE_CODE_ENABLED`, `CODEX_CLI_ENABLED`). */
  providers: ProviderSwitches;
  /** The CLI binary per provider (`CLAUDE_CODE_BIN`, `CODEX_CLI_BIN`), for the spawn boundary. */
  providerBinaries: ProviderBinaries;
  /** Absolute directory of the per-project caches and the Runs' directories (Issue #98). */
  dataDir: string;
  /** The Agent account's Git identity, set in each Working copy. */
  agentGitName: string;
  agentGitEmail: string;
  /** A finished Working copy is removed after this many days... */
  retentionDays: number;
  /** ...and beyond the newest this many per Project. */
  retentionMaxPerProject: number;
  /** Grace between the interrupt and the kill of a stopped Run step's processes (Issue #100). */
  killGraceMs: number;
  /** The Agent account on GitHub (Issue #102): its token (if configured) and the API base URL. */
  agentGitHub: AgentGitHubConfig;
}

/** How the worker reaches GitHub as the Agent account (Issue #102). */
export interface AgentGitHubConfig {
  /** Never logged, never written to a Working copy; absent when not configured. */
  token?: string;
  /** Base URL of the GitHub REST API, without a trailing slash. */
  apiUrl: string;
}

/** Thrown when the environment is invalid. Names variables, never their values. */
export class WorkerConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid agent worker configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'WorkerConfigError';
  }
}

/**
 * Validates the worker's environment once at start-up. Throws {@link WorkerConfigError},
 * naming variables but never their values, when a setting is invalid or when a Studio-side
 * variable ({@link STUDIO_SIDE_VARIABLES}) is present.
 */
export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const leaked = STUDIO_SIDE_VARIABLES.filter((name) => env[name] !== undefined);
  if (leaked.length > 0) {
    throw new WorkerConfigError(
      leaked.map(
        (name) =>
          `${name}: is a Studio-side setting and must not be in the agent worker's environment ` +
          '(give the worker its own apps/agent-worker/.env, never the root .env of Studio)',
      ),
    );
  }
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw new WorkerConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  if (
    result.data.STUDIO_WORKER_RUNNER === 'fake' &&
    result.data.STUDIO_WORKER_ENVIRONMENT === 'production'
  ) {
    throw new WorkerConfigError([
      'STUDIO_WORKER_RUNNER: fake is allowed only when STUDIO_WORKER_ENVIRONMENT is ' +
        'development or test (the default environment is production)',
    ]);
  }
  const githubApiUrl = result.data.STUDIO_AGENT_GITHUB_API_URL.replace(/\/+$/, '');
  if (
    result.data.STUDIO_WORKER_ENVIRONMENT === 'production' &&
    !githubApiUrl.startsWith('https://')
  ) {
    throw new WorkerConfigError([
      'STUDIO_AGENT_GITHUB_API_URL: must be an https URL (plain http only for a development or ' +
        'test worker, e.g. a stub)',
    ]);
  }
  const githubToken = result.data.STUDIO_AGENT_GITHUB_TOKEN;
  return {
    apiUrl: result.data.STUDIO_API_URL.replace(/\/+$/, ''),
    token: result.data.STUDIO_WORKER_TOKEN,
    pollMs: result.data.STUDIO_WORKER_POLL_MS,
    heartbeatMs: result.data.STUDIO_WORKER_HEARTBEAT_MS,
    requestTimeoutMs: result.data.STUDIO_WORKER_REQUEST_TIMEOUT_MS,
    runner: result.data.STUDIO_WORKER_RUNNER,
    environment: result.data.STUDIO_WORKER_ENVIRONMENT,
    // Not validated like the rest: a malformed switch is not an error, it is off.
    providers: readProviderSwitches(env),
    providerBinaries: Object.freeze({
      claude_code: result.data.CLAUDE_CODE_BIN,
      codex: result.data.CODEX_CLI_BIN,
    }),
    dataDir: result.data.STUDIO_WORKER_DATA_DIR,
    agentGitName: result.data.STUDIO_AGENT_GIT_NAME,
    agentGitEmail: result.data.STUDIO_AGENT_GIT_EMAIL,
    retentionDays: result.data.STUDIO_WORKER_RETENTION_DAYS,
    retentionMaxPerProject: result.data.STUDIO_WORKER_RETENTION_MAX_PER_PROJECT,
    killGraceMs: result.data.STUDIO_WORKER_KILL_GRACE_SECONDS * 1000,
    agentGitHub: {
      ...(githubToken ? { token: githubToken } : {}),
      apiUrl: githubApiUrl,
    },
  };
}

/** The agent worker runs on Linux only (ADR 0002); elsewhere it refuses to start. */
export class UnsupportedPlatformError extends Error {
  constructor(platform: string) {
    super(
      `The agent worker runs on Linux only, and this is ${platform}. ` +
        'Run it on the Linux host as the agent user.',
    );
    this.name = 'UnsupportedPlatformError';
  }
}

export function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform !== 'linux') throw new UnsupportedPlatformError(platform);
}
