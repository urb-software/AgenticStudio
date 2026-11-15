import { z } from 'zod';

/** Shortest accepted worker token; the API applies the same rule (Issue #96). */
export const WORKER_TOKEN_MIN_LENGTH = 32;

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
});

export interface WorkerConfig {
  /** Base URL of the Studio API, without a trailing slash (e.g. `http://127.0.0.1:3001`). */
  apiUrl: string;
  /** Sent as `Authorization: Bearer`; never logged. */
  token: string;
  /** Pause between two claims when there is no work. */
  pollMs: number;
  /** Interval of heartbeats while the worker carries a Run. */
  heartbeatMs: number;
}

/** Thrown when the environment is invalid. Names variables, never their values. */
export class WorkerConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid agent worker configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'WorkerConfigError';
  }
}

export function loadWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw new WorkerConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return {
    apiUrl: result.data.STUDIO_API_URL.replace(/\/+$/, ''),
    token: result.data.STUDIO_WORKER_TOKEN,
    pollMs: result.data.STUDIO_WORKER_POLL_MS,
    heartbeatMs: result.data.STUDIO_WORKER_HEARTBEAT_MS,
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
