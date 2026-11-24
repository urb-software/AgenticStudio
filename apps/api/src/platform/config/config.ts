import { createHash, createSecretKey, type KeyObject } from 'node:crypto';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { MergeCredential } from './merge-credential.js';
import { parseKnownHosts, type SshKnownHost } from './ssh-known-hosts.js';

export { MergeCredential } from './merge-credential.js';

export type { SshKnownHost } from './ssh-known-hosts.js';

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

/** Length of the AES-256 master key behind the SecretStore (ADR 0001). */
const SECRETS_KEY_BYTES = 32;
/** Standard base64 with padding, as `openssl rand -base64 32` prints it. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SECRETS_KEY_HINT = 'generate one with `openssl rand -base64 32` (see README.md)';

// Messages never echo the value: it is the master key that protects every stored secret.
// The parsed key is a KeyObject, which never prints its bytes when logged or serialized.
const secretsKeySchema = z
  .string({ error: `required: 32 random bytes, base64-encoded; ${SECRETS_KEY_HINT}` })
  .refine((value) => value.length > 0 && BASE64.test(value), {
    message: `must be standard base64 (A-Z, a-z, 0-9, +, /, = padding); ${SECRETS_KEY_HINT}`,
    abort: true,
  })
  .refine((value) => Buffer.from(value, 'base64').length === SECRETS_KEY_BYTES, {
    message: `must decode to exactly ${SECRETS_KEY_BYTES} bytes; ${SECRETS_KEY_HINT}`,
  })
  .transform((value) => createSecretKey(Buffer.from(value, 'base64')));

/** Shortest accepted agent worker or environment controller token. */
export const WORKER_TOKEN_MIN_LENGTH = 32;

/**
 * A bearer token setting (`STUDIO_WORKER_TOKEN`, `STUDIO_CONTROLLER_TOKEN`).
 * Unset or empty: no token, and every route it guards rejects (fail closed). Only its SHA-256
 * digest is kept, as a KeyObject that never prints; messages never echo the value.
 */
const bearerTokenSchema = z
  .string()
  .optional()
  .transform((value) => (value === '' ? undefined : value))
  .refine((value) => value === undefined || value.length >= WORKER_TOKEN_MIN_LENGTH, {
    message: `must be at least ${WORKER_TOKEN_MIN_LENGTH} characters; generate one with \`openssl rand -base64 32\``,
  })
  .transform((value) =>
    value === undefined ? null : createSecretKey(createHash('sha256').update(value).digest()),
  );

/**
 * `STUDIO_MERGE_TOKEN`: the Merge credential. Unset or empty: merging is off. Otherwise one
 * line without whitespace of 20 to 255 characters; messages never echo the value.
 */
const mergeTokenSchema = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value))
  .refine((value) => value === null || MergeCredential.isWellFormed(value), {
    message: `must be one line without whitespace, ${MergeCredential.MIN_LENGTH} to ${MergeCredential.MAX_LENGTH} characters`,
  })
  .transform((value) => (value === null ? null : MergeCredential.of(value)));

/** `STUDIO_OPERATOR_GITHUB_LOGIN`: a GitHub login (letters, digits, single hyphens), or none. */
const githubLoginSchema = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim()))
  .refine((value) => value === null || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value), {
    message: 'must be a GitHub login: letters, digits and hyphens, at most 39 characters',
  });

/** A DNS name: two or more lowercase LDH labels of at most 63 characters, 253 in all, not an IP address. */
function isDnsName(value: string): boolean {
  const labels = value.split('.');
  return (
    value.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !/^\d+$/.test(labels[labels.length - 1]!)
  );
}

/**
 * `STUDIO_PREVIEW_DOMAIN`: the domain Previews are served under. Unset or empty: no hostname is
 * shown. Messages never echo the value.
 */
const previewDomainSchema = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value.trim() === '' ? null : value.trim().toLowerCase(),
  )
  .refine((value) => value === null || isDnsName(value), {
    message:
      'must be a DNS name of lowercase letters, digits and hyphens, e.g. preview.example.test',
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

/** Whether `child` is `parent` or lies inside it (lexically; pass real paths to resolve links). */
export function isSameOrInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Characters a path may hold to be embedded, single-quoted, in `GIT_SSH_COMMAND`. */
export const SHELL_SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/**
 * `STUDIO_SSH_KNOWN_HOSTS`: the Git hosts Studio trusts without asking, as
 * standard known_hosts lines (see `ssh-known-hosts.ts`, shared with the Git adapter). An
 * empty value trusts no host. Messages name the line number, never its content.
 */
const sshKnownHostsSchema = z
  .string()
  .default('')
  .transform((value, context) => {
    const { entries, problems } = parseKnownHosts(value);
    for (const message of problems) context.addIssue({ code: 'custom', message });
    return entries;
  });

/**
 * `STUDIO_DATA_DIR` (Clones and other repository data): an absolute, existing,
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
    .refine((value) => process.platform === 'win32' || SHELL_SAFE_PATH.test(value), {
      message:
        'may contain only letters, digits and "._/-" (no spaces): SSH key paths under it go on a command line',
      abort: true,
    })
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
  // Bind address: localhost by default; a deployment sets it explicitly.
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
  // AES-256-GCM master key of the SecretStore (ADR 0001); never stored in the database.
  STUDIO_SECRETS_KEY: secretsKeySchema,
  // Test-only: adds `file` remotes to the Git adapter's transports (local fixture remotes).
  STUDIO_GIT_ALLOW_FILE_REMOTES: z.enum(['true', 'false']).default('false'),
  // Git remotes on loopback and private addresses: closed unless set to true.
  STUDIO_GIT_ALLOW_PRIVATE_REMOTES: z.enum(['true', 'false']).default('false'),
  STUDIO_SSH_KNOWN_HOSTS: sshKnownHostsSchema,
  STUDIO_WORKER_TOKEN: bearerTokenSchema,
  // How long a claimed Run may go without a heartbeat before it fails as worker_lost.
  STUDIO_WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  // The environment controller's own token; never the worker token.
  STUDIO_CONTROLLER_TOKEN: bearerTokenSchema,
  // How long a claimed Preview operation may go without a heartbeat before it fails as controller_lost.
  STUDIO_CONTROLLER_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  // Limits copied onto every Preview build; the bounds are the controller protocol's
  // (`PREVIEW_LIMIT_BOUNDS`).
  STUDIO_PREVIEW_MEMORY_MB: z.coerce.number().int().min(128).max(65_536).default(1024),
  STUDIO_PREVIEW_CPU_PERCENT: z.coerce.number().int().min(10).max(6400).default(100),
  STUDIO_PREVIEW_TASKS_MAX: z.coerce.number().int().min(64).max(32_768).default(512),
  STUDIO_PREVIEW_BUILD_MINUTES: z.coerce.number().int().min(1).max(120).default(20),
  STUDIO_PREVIEW_LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(1024 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  // Run limits copied onto every new Run; the upper bounds are the worker protocol's
  // (`RUN_STEP_MINUTES_MAX`, `RUN_MAX_STEPS_MAX`).
  STUDIO_RUN_STEP_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  STUDIO_RUN_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(10),
  STUDIO_RUN_WAITING_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  // STUDIO_RUN_MAX_STEPS is the allowance of the first part and of each Follow-up; a Run at
  // this many Run steps in total takes no further Follow-up.
  STUDIO_RUN_MAX_TOTAL_STEPS: z.coerce.number().int().min(1).max(10_000).default(50),
  STUDIO_RUN_LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(1024 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  // Days an Environment file snapshot is kept while its failed delivery can be retried.
  STUDIO_RUN_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  // How long a finished Run's agent-side Working copy is kept; Studio decides, the worker removes.
  // No pull request: _DAYS after the Run, at most _MAX_PER_PROJECT per Project. With one:
  // _OPEN_PR_IDLE_DAYS idle or _AFTER_PR_END_HOURS after merge/close, whichever comes first.
  STUDIO_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  STUDIO_RETENTION_MAX_PER_PROJECT: z.coerce.number().int().min(0).max(1000).default(10),
  STUDIO_RETENTION_OPEN_PR_IDLE_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  STUDIO_RETENTION_AFTER_PR_END_HOURS: z.coerce.number().int().min(0).max(8760).default(24),
  // The operator's own GitHub login, matched case-insensitively; its Review comments are
  // preselected. Unset or empty: nothing is preselected.
  STUDIO_OPERATOR_GITHUB_LOGIN: githubLoginSchema,
  // The Merge credential (merging is off while unset); only an operator's merge or close uses it.
  STUDIO_MERGE_TOKEN: mergeTokenSchema,
  // Test-only: the GitHub API the merge adapter calls instead of api.github.com.
  STUDIO_MERGE_GITHUB_API_URL: z.url({ protocol: /^https?$/ }).optional(),
  // The domain Previews are served under (security.md section 5); never Studio's own hostname.
  STUDIO_PREVIEW_DOMAIN: previewDomainSchema,
  NODE_ENV: z.string().optional(),
});

function isStudioHostnameOrBelow(domain: string | null, studioOrigin: string): boolean {
  if (domain === null) return false;
  // A trailing dot names the same host.
  const studioHost = new URL(studioOrigin).hostname.toLowerCase().replace(/[.]$/, '');
  return domain === studioHost || domain.endsWith(`.${studioHost}`);
}

function schemaFor(workspaceRoot: string | undefined) {
  return environmentSchema
    .extend({ STUDIO_DATA_DIR: dataDirSchema(workspaceRoot) })
    .refine((env) => env.STUDIO_GIT_ALLOW_FILE_REMOTES !== 'true' || env.NODE_ENV === 'test', {
      path: ['STUDIO_GIT_ALLOW_FILE_REMOTES'],
      message: 'is a test-only setting; it is accepted only with NODE_ENV=test',
    })
    .refine((env) => !isStudioHostnameOrBelow(env.STUDIO_PREVIEW_DOMAIN, env.STUDIO_ORIGIN), {
      path: ['STUDIO_PREVIEW_DOMAIN'],
      message:
        "must not be Studio's own hostname or a name under it: a Preview needs its own origin " +
        '(security.md section 5)',
    })
    .refine(
      (env) =>
        env.STUDIO_CONTROLLER_TOKEN === null ||
        env.STUDIO_WORKER_TOKEN === null ||
        !env.STUDIO_CONTROLLER_TOKEN.export().equals(env.STUDIO_WORKER_TOKEN.export()),
      {
        path: ['STUDIO_CONTROLLER_TOKEN'],
        message: 'must differ from STUDIO_WORKER_TOKEN: the two protocols never share a credential',
      },
    )
    .refine((env) => env.STUDIO_MERGE_GITHUB_API_URL === undefined || env.NODE_ENV === 'test', {
      path: ['STUDIO_MERGE_GITHUB_API_URL'],
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
  /** Master key of the SecretStore. Only `platform/secrets` reads it (ADR 0001). */
  secretsKey: KeyObject;
  /** Absolute data directory for repository data (Clones). */
  dataDir: string;
  /** Test-only: whether the Git adapter also accepts `file` remotes. */
  gitAllowFileRemotes: boolean;
  /**
   * Whether Git remotes on loopback and private addresses are allowed (a self-hosted Git
   * server on the LAN). Link-local and metadata addresses are refused regardless.
   */
  gitAllowPrivateRemotes: boolean;
  /** Trusted Git host keys (`STUDIO_SSH_KNOWN_HOSTS`); empty trusts no host without asking. */
  sshKnownHosts: SshKnownHost[];
  /**
   * SHA-256 digest of `STUDIO_WORKER_TOKEN`, or `null` when unset (every worker route then
   * rejects). Only `platform/auth` reads it; the token itself is never kept.
   */
  workerToken: KeyObject | null;
  /** Seconds a claimed Run may go without a heartbeat before it fails with `worker_lost`. */
  workerLeaseSeconds: number;
  /**
   * SHA-256 digest of `STUDIO_CONTROLLER_TOKEN`, or `null` when unset (every controller route
   * then answers 401).
   */
  controllerToken: KeyObject | null;
  /** Seconds a claimed Preview operation may go without a heartbeat before `controller_lost`. */
  controllerLeaseSeconds: number;
  /** Limits copied onto every new Preview build. */
  previewLimits: { memoryMiB: number; cpuPercent: number; tasksMax: number; buildMinutes: number };
  /** Bytes of Preview operation log kept per operation; later lines are dropped. */
  previewLogMaxBytes: number;
  /** The limits copied onto every new Run. */
  runLimits: { stepMinutes: number; maxSteps: number; waitingDays: number; maxTotalSteps: number };
  /** Per-Run log cap in UTF-8 bytes of event text (`STUDIO_RUN_LOG_MAX_BYTES`, default 8 MiB). */
  runLogMaxBytes: number;
  /**
   * Days a Run's Environment file snapshot is kept for its log redaction while its failed
   * delivery can be retried (`STUDIO_RUN_SNAPSHOT_RETENTION_DAYS`, default 7).
   */
  runSnapshotRetentionDays: number;
  /**
   * The operator's own GitHub login (`STUDIO_OPERATOR_GITHUB_LOGIN`), or `null`:
   * the author of the Review comments that are preselected.
   */
  operatorGithubLogin: string | null;
  /**
   * The Merge credential (`STUDIO_MERGE_TOKEN`), or `null` while merging is off. It prints as
   * redacted; only the merge adapter's wiring reveals it.
   */
  mergeCredential: MergeCredential | null;
  /** Test-only: the GitHub API base the merge adapter calls, `null` for the real one. */
  mergeGithubApiUrl: string | null;
  /** The domain Previews are served under (`STUDIO_PREVIEW_DOMAIN`), or `null` while unset. */
  previewDomain: string | null;
  /** Agent-side Working copy retention, from the `STUDIO_RETENTION_*` settings. */
  retention: {
    days: number;
    maxPerProject: number;
    openPullRequestIdleDays: number;
    hoursAfterPullRequestEnd: number;
  };
}

export interface LoadConfigOptions {
  /** The repository checkout the data directory must stay out of; found by default. */
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
    secretsKey: result.data.STUDIO_SECRETS_KEY,
    dataDir: result.data.STUDIO_DATA_DIR,
    gitAllowFileRemotes: result.data.STUDIO_GIT_ALLOW_FILE_REMOTES === 'true',
    gitAllowPrivateRemotes: result.data.STUDIO_GIT_ALLOW_PRIVATE_REMOTES === 'true',
    sshKnownHosts: result.data.STUDIO_SSH_KNOWN_HOSTS,
    workerToken: result.data.STUDIO_WORKER_TOKEN,
    workerLeaseSeconds: result.data.STUDIO_WORKER_LEASE_SECONDS,
    controllerToken: result.data.STUDIO_CONTROLLER_TOKEN,
    controllerLeaseSeconds: result.data.STUDIO_CONTROLLER_LEASE_SECONDS,
    previewLimits: {
      memoryMiB: result.data.STUDIO_PREVIEW_MEMORY_MB,
      cpuPercent: result.data.STUDIO_PREVIEW_CPU_PERCENT,
      tasksMax: result.data.STUDIO_PREVIEW_TASKS_MAX,
      buildMinutes: result.data.STUDIO_PREVIEW_BUILD_MINUTES,
    },
    previewLogMaxBytes: result.data.STUDIO_PREVIEW_LOG_MAX_BYTES,
    runLimits: {
      stepMinutes: result.data.STUDIO_RUN_STEP_MINUTES,
      maxSteps: result.data.STUDIO_RUN_MAX_STEPS,
      waitingDays: result.data.STUDIO_RUN_WAITING_DAYS,
      maxTotalSteps: result.data.STUDIO_RUN_MAX_TOTAL_STEPS,
    },
    runLogMaxBytes: result.data.STUDIO_RUN_LOG_MAX_BYTES,
    runSnapshotRetentionDays: result.data.STUDIO_RUN_SNAPSHOT_RETENTION_DAYS,
    operatorGithubLogin: result.data.STUDIO_OPERATOR_GITHUB_LOGIN,
    mergeCredential: result.data.STUDIO_MERGE_TOKEN,
    mergeGithubApiUrl: result.data.STUDIO_MERGE_GITHUB_API_URL?.replace(/\/+$/, '') ?? null,
    previewDomain: result.data.STUDIO_PREVIEW_DOMAIN,
    retention: {
      days: result.data.STUDIO_RETENTION_DAYS,
      maxPerProject: result.data.STUDIO_RETENTION_MAX_PER_PROJECT,
      openPullRequestIdleDays: result.data.STUDIO_RETENTION_OPEN_PR_IDLE_DAYS,
      hoursAfterPullRequestEnd: result.data.STUDIO_RETENTION_AFTER_PR_END_HOURS,
    },
  };
}
