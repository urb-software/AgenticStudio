import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';

const DEFAULT_API_PORT = 3001;

/** OWASP Argon2id baseline (security.md §8): m=19 MiB, t=2, p=1. */
export const ARGON2ID_BASELINE = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const ARGON2ID_PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** Hosts for which a plain-HTTP Studio origin (and so a non-Secure cookie) is allowed. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An IPv4/IPv6 address or a CIDR range (`10.0.0.0/8`, `fd00::/8`). */
function isIpOrCidr(value: string): boolean {
  const [address = '', prefix, ...rest] = value.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

function meetsArgon2idBaseline(value: string): boolean {
  const match = ARGON2ID_PHC.exec(value);
  if (!match) {
    return false;
  }
  const [memoryCost, timeCost, parallelism] = match.slice(1, 4).map(Number) as [
    number,
    number,
    number,
  ];
  return (
    memoryCost >= ARGON2ID_BASELINE.memoryCost &&
    timeCost >= ARGON2ID_BASELINE.timeCost &&
    parallelism >= ARGON2ID_BASELINE.parallelism
  );
}

// Messages never echo the value: it is a password hash (or, by mistake, a plaintext).
const passwordHashSchema = z.string().refine(meetsArgon2idBaseline, {
  message:
    'must be an Argon2id PHC string (v=19) with at least m=19456, t=2, p=1; generate it with the hash-password helper',
});

const studioOriginSchema = z
  .url({ protocol: /^https?$/ })
  .refine((value) => new URL(value).origin === value.replace(/\/$/, ''), {
    message: 'must be a bare origin (scheme://host[:port]) without a path, query or fragment',
  })
  .refine(
    (value) => {
      const url = new URL(value);
      return url.protocol === 'https:' || LOCAL_HOSTNAMES.has(url.hostname);
    },
    { message: 'must use https unless the host is localhost (HTTP cookies are development-only)' },
  )
  .transform((value) => new URL(value).origin);

const trustedProxiesSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .refine((entries) => entries.every(isIpOrCidr), {
    message: 'must be a comma-separated list of IP addresses or CIDR ranges',
  });

/**
 * The repository checkout the API runs from: the nearest ancestor of `start` holding
 * `pnpm-workspace.yaml`, or `undefined` outside a checkout (e.g. a deployment bundle).
 */
export function findWorkspaceRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function isSameOrInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * `STUDIO_DATA_DIR` (Clones and other repository data, Epic #55): an absolute, existing,
 * writable directory outside the repository checkout. Messages never echo the path.
 */
function dataDirSchema(workspaceRoot: string | undefined) {
  return z
    .string({ error: 'is required: an absolute path outside the repository checkout' })
    .refine((value) => isAbsolute(value), { message: 'must be an absolute path', abort: true })
    .refine((value) => statSync(value, { throwIfNoEntry: false })?.isDirectory() === true, {
      message: 'must be an existing directory',
      abort: true,
    })
    .refine(
      (value) => {
        try {
          accessSync(value, constants.W_OK);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'must be writable', abort: true },
    )
    .refine(
      (value) =>
        workspaceRoot === undefined ||
        !isSameOrInside(realpathSync(workspaceRoot), realpathSync(value)),
      { message: 'must be outside the repository checkout' },
    );
}

const environmentSchema = z.object({
  // API_PORT, not PORT: `next dev` also reads PORT, so a shell-wide PORT would put
  // both apps on the same port.
  API_PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_API_PORT),
  // Bind address: localhost by default (#17 follow-up); a deployment sets it explicitly.
  API_HOST: z
    .string()
    .refine((value) => isIP(value) !== 0 || /^[a-z\d]([a-z\d.-]*[a-z\d])?$/i.test(value), {
      message: 'must be an IP address or a hostname',
    })
    .default('127.0.0.1'),
  // Where the web app's `next dev` /api rewrite reaches this API.
  API_ORIGIN: z.url({ protocol: /^https?$/ }).default(`http://localhost:${DEFAULT_API_PORT}`),
  // Proxies whose X-Forwarded-For is honoured for the client IP; empty = socket address.
  API_TRUSTED_PROXIES: trustedProxiesSchema,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // The only origin accepted on mutations; https makes the session cookie Secure.
  STUDIO_ORIGIN: studioOriginSchema.default('http://localhost:3000'),
  STUDIO_OPERATOR_PASSWORD_HASH: passwordHashSchema,
  // Test-only: adds `file` remotes to the Git adapter's transports (local fixture remotes).
  STUDIO_GIT_ALLOW_FILE_REMOTES: z.enum(['true', 'false']).default('false'),
  NODE_ENV: z.string().optional(),
});

function schemaFor(workspaceRoot: string | undefined) {
  return environmentSchema
    .extend({ STUDIO_DATA_DIR: dataDirSchema(workspaceRoot) })
    .refine((env) => env.STUDIO_GIT_ALLOW_FILE_REMOTES !== 'true' || env.NODE_ENV === 'test', {
      path: ['STUDIO_GIT_ALLOW_FILE_REMOTES'],
      message: 'is a test-only setting; it is accepted only with NODE_ENV=test',
    });
}

export interface AppConfig {
  apiPort: number;
  apiHost: string;
  apiOrigin: string;
  apiTrustedProxies: string[];
  databaseUrl: string;
  redisUrl: string;
  studioOrigin: string;
  operatorPasswordHash: string;
  /** Absolute data directory for repository data (Clones). */
  dataDir: string;
  /** Test-only: whether the Git adapter also accepts `file` remotes. */
  gitAllowFileRemotes: boolean;
}

export interface LoadConfigOptions {
  /** The repository checkout the data directory must stay out of; found from this file by default. */
  workspaceRoot?: string;
}

/** DI token for the validated {@link AppConfig}. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** Thrown when the environment is invalid. Names variables, never their values. */
export class ConfigValidationError extends Error {
  constructor(problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Validates the environment once at start-up; throws instead of running half-configured. */
export function loadConfig(
  env: Record<string, string | undefined>,
  options: LoadConfigOptions = {},
): AppConfig {
  const workspaceRoot = options.workspaceRoot ?? findWorkspaceRoot(import.meta.dirname);
  const result = schemaFor(workspaceRoot).safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return {
    apiPort: result.data.API_PORT,
    apiHost: result.data.API_HOST,
    apiOrigin: result.data.API_ORIGIN,
    apiTrustedProxies: result.data.API_TRUSTED_PROXIES,
    databaseUrl: result.data.DATABASE_URL,
    redisUrl: result.data.REDIS_URL,
    studioOrigin: result.data.STUDIO_ORIGIN,
    operatorPasswordHash: result.data.STUDIO_OPERATOR_PASSWORD_HASH,
    dataDir: result.data.STUDIO_DATA_DIR,
    gitAllowFileRemotes: result.data.STUDIO_GIT_ALLOW_FILE_REMOTES === 'true',
  };
}
