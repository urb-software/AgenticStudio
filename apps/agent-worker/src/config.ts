import { WORKER_RUNNER_MODES, type WorkerRunnerMode } from '@agentic-studio/contracts';
import { z } from 'zod';
import { type ProviderSwitches, readProviderSwitches } from './provider-gate.js';

/** Shortest accepted worker token; the API applies the same rule (Issue #96). */
export const WORKER_TOKEN_MIN_LENGTH = 32;

/** Where the worker is deployed; it decides whether the fake runner is allowed (Issue #101). */
export const WORKER_ENVIRONMENTS = ['production', 'development', 'test'] as const;
export type WorkerEnvironment = (typeof WORKER_ENVIRONMENTS)[number];

const intervalMs = (fallback: number) =>
  z.coerce.number().int().min(100).max(600_000).default(fallback);

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
  // Production unless said otherwise; only development and test allow the fake runner.
  STUDIO_WORKER_ENVIRONMENT: z.enum(WORKER_ENVIRONMENTS).default('production'),
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
  environment: WorkerEnvironment;
  /** The operator's provider switches, read once (`CLAUDE_CODE_ENABLED`, `CODEX_CLI_ENABLED`). */
  providers: ProviderSwitches;
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
