/**
 * The environment a provider CLI process gets: only an allowlist of the
 * worker's own variables, never its secrets. Shared by the Claude Code and Codex runners.
 */

/**
 * The only worker variables a provider CLI gets; everything else is dropped: provider credentials
 * and overrides (`ANTHROPIC_*`, `CLAUDE_CODE_*`, `OPENAI_*`, `CODEX_*`, `CODEX_HOME`) and the
 * worker's and Studio's own tokens and settings.
 */
export const PROVIDER_PASSED_VARIABLES = [
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

export interface ProviderEnvironmentInput {
  /** The worker's own environment, filtered here. */
  base: Record<string, string | undefined>;
  /** The Run step's temporary directory in the Run's directory (none for the version check). */
  tmpDir?: string;
  /** The Run's Compose project name (`COMPOSE_PROJECT_NAME`), when it has one. */
  composeProjectName?: string;
}

/**
 * The complete environment of a provider CLI process: the allowlisted variables of the worker's
 * environment (`DOCKER_HOST` only when it is not the system daemon's socket), `TERM=dumb`, the
 * Run step's `TMPDIR` and the Run's `COMPOSE_PROJECT_NAME`.
 */
export function providerEnvironment(input: ProviderEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PROVIDER_PASSED_VARIABLES) {
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
