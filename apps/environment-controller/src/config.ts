import { z } from 'zod';

/** Shortest accepted controller token. */
export const CONTROLLER_TOKEN_MIN_LENGTH = 32;

export const CONTROLLER_ENVIRONMENTS = ['production', 'development', 'test'] as const;
export const CONTROLLER_RUNTIMES = ['docker', 'fake'] as const;

export const DEFAULT_PROXY_GID = 2003;
export const DEFAULT_PROXY_DIR = '/run/preview-proxy';
export const DEFAULT_EGRESS_RULES_BIN = '/usr/local/lib/agentic-studio/preview-egress-rules';

/**
 * Settings that belong to Studio or to the agent side and must never reach the controller. If
 * one is present (a root `.env` was loaded), the controller refuses to start.
 */
export const FORBIDDEN_VARIABLES = [
  'DATABASE_URL',
  'REDIS_URL',
  'STUDIO_SECRETS_KEY',
  'STUDIO_OPERATOR_PASSWORD_HASH',
  'STUDIO_MERGE_TOKEN',
  'POSTGRES_PASSWORD',
  'STUDIO_WORKER_TOKEN',
  'STUDIO_AGENT_GITHUB_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
] as const;

const intervalMs = (fallback: number) =>
  z.coerce.number().int().min(100).max(600_000).default(fallback);

const absolutePath = (message: string) =>
  z
    .string({ error: message })
    .refine((value) => value.startsWith('/') && !value.includes('\0'), {
      message: 'must be an absolute path',
    })
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => value !== '', { message: 'must not be the root directory' });

const environmentSchema = z.object({
  STUDIO_API_URL: z.url({ protocol: /^https?$/, error: 'is required: the Studio API URL' }),
  // Messages never echo the token.
  STUDIO_CONTROLLER_TOKEN: z
    .string({ error: `is required: at least ${CONTROLLER_TOKEN_MIN_LENGTH} characters` })
    .refine((value) => value.length >= CONTROLLER_TOKEN_MIN_LENGTH, {
      message: `must be at least ${CONTROLLER_TOKEN_MIN_LENGTH} characters`,
    }),
  STUDIO_CONTROLLER_ENVIRONMENT: z.enum(CONTROLLER_ENVIRONMENTS).default('production'),
  STUDIO_CONTROLLER_RUNTIME: z.enum(CONTROLLER_RUNTIMES).default('docker'),
  STUDIO_CONTROLLER_DATA_DIR: absolutePath('is required: an absolute directory path'),
  STUDIO_CONTROLLER_POLL_MS: intervalMs(5000),
  STUDIO_CONTROLLER_HEARTBEAT_MS: intervalMs(15_000),
  STUDIO_CONTROLLER_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .default(30_000),
  STUDIO_CONTROLLER_KILL_GRACE_SECONDS: z.coerce.number().int().min(1).max(300).default(10),
  STUDIO_CONTROLLER_MIN_FREE_GB: z.coerce.number().min(0).max(100_000).default(2),
  STUDIO_CONTROLLER_PROXY_GID: z.coerce
    .number()
    .int()
    .min(1)
    .max(4_294_967_294)
    .default(DEFAULT_PROXY_GID),
  STUDIO_CONTROLLER_PROXY_DIR: absolutePath('must be an absolute directory path').default(
    DEFAULT_PROXY_DIR,
  ),
  STUDIO_CONTROLLER_EGRESS_RULES_BIN: absolutePath('must be an absolute path').default(
    DEFAULT_EGRESS_RULES_BIN,
  ),
  // Whether Docker is the Preview user's rootless daemon (always, in production).
  STUDIO_CONTROLLER_ROOTLESS: z.enum(['true', 'false']).default('true'),
  HOME: absolutePath('is required: the Preview user home').optional(),
  XDG_RUNTIME_DIR: absolutePath('is required: the Preview user runtime directory').optional(),
  DOCKER_HOST: z.string().optional(),
});

/** Every setting the controller reads, in the order of the example file. */
export const SETTING_NAMES = Object.keys(environmentSchema.shape);

export interface ControllerConfig {
  /** Base URL of the Studio API, without a trailing slash. */
  apiUrl: string;
  token: string;
  environment: (typeof CONTROLLER_ENVIRONMENTS)[number];
  runtime: (typeof CONTROLLER_RUNTIMES)[number];
  dataDir: string;
  pollMs: number;
  heartbeatMs: number;
  requestTimeoutMs: number;
  killGraceMs: number;
  minFreeBytes: number;
  proxyGid: number;
  proxyDir: string;
  egressRulesBin: string;
  rootless: boolean;
  /** Only with the Docker runtime. */
  docker: { home: string; xdgRuntimeDir: string; dockerHost: string } | null;
}

/** The environment cannot be used; the message names settings, never their values. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment controller settings: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

/** Reads and checks the settings from `env`; throws `ConfigError`. */
export function loadConfig(env: Record<string, string | undefined>): ControllerConfig {
  const forbidden = FORBIDDEN_VARIABLES.filter((name) => env[name] !== undefined);
  if (forbidden.length > 0) {
    throw new ConfigError([
      `${forbidden.join(', ')} must not be set for the controller (Studio-side or agent-side setting)`,
    ]);
  }
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'settings'} ${issue.message}`),
    );
  }
  const value = parsed.data;
  const problems: string[] = [];
  const production = value.STUDIO_CONTROLLER_ENVIRONMENT === 'production';
  const rootless = value.STUDIO_CONTROLLER_ROOTLESS === 'true';
  if (production && value.STUDIO_CONTROLLER_RUNTIME === 'fake') {
    problems.push('STUDIO_CONTROLLER_RUNTIME=fake is allowed only in development or test');
  }
  if (production && value.STUDIO_CONTROLLER_EGRESS_RULES_BIN !== DEFAULT_EGRESS_RULES_BIN) {
    problems.push('STUDIO_CONTROLLER_EGRESS_RULES_BIN may be changed only in development or test');
  }
  if (production && !rootless) {
    problems.push('STUDIO_CONTROLLER_ROOTLESS=false is allowed only in development or test');
  }

  let docker: ControllerConfig['docker'] = null;
  if (value.STUDIO_CONTROLLER_RUNTIME === 'docker') {
    const { HOME: home, XDG_RUNTIME_DIR: xdg, DOCKER_HOST: host } = value;
    if (!home) problems.push('HOME is required: the Preview user home');
    if (!xdg) problems.push('XDG_RUNTIME_DIR is required: the Preview user runtime directory');
    if (home && xdg) {
      if (rootless && host !== `unix://${xdg}/docker.sock`) {
        problems.push(
          'DOCKER_HOST must be unix://$XDG_RUNTIME_DIR/docker.sock (the rootless daemon)',
        );
      } else if (!host) {
        problems.push('DOCKER_HOST is required');
      } else {
        docker = { home, xdgRuntimeDir: xdg, dockerHost: host };
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    apiUrl: value.STUDIO_API_URL.replace(/\/+$/, ''),
    token: value.STUDIO_CONTROLLER_TOKEN,
    environment: value.STUDIO_CONTROLLER_ENVIRONMENT,
    runtime: value.STUDIO_CONTROLLER_RUNTIME,
    dataDir: value.STUDIO_CONTROLLER_DATA_DIR,
    pollMs: value.STUDIO_CONTROLLER_POLL_MS,
    heartbeatMs: value.STUDIO_CONTROLLER_HEARTBEAT_MS,
    requestTimeoutMs: value.STUDIO_CONTROLLER_REQUEST_TIMEOUT_MS,
    killGraceMs: value.STUDIO_CONTROLLER_KILL_GRACE_SECONDS * 1000,
    minFreeBytes: Math.round(value.STUDIO_CONTROLLER_MIN_FREE_GB * 1024 ** 3),
    proxyGid: value.STUDIO_CONTROLLER_PROXY_GID,
    proxyDir: value.STUDIO_CONTROLLER_PROXY_DIR,
    egressRulesBin: value.STUDIO_CONTROLLER_EGRESS_RULES_BIN,
    rootless,
    docker,
  };
}
