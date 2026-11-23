/**
 * The explicit list of Compose keys the validation knows. Anything else is refused with
 * `unknown_key`. Adding a key here is a security decision: review it against security.md §5.
 */

/** Top-level keys. `x-*` extension fields are dropped by the validation, see `isExtensionKey`. */
export const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'services',
  'volumes',
  'networks',
  'include',
]);

/**
 * Service keys. `privileged`, `cap_add`, `devices`, `network_mode`, `pid` and `ipc` are listed
 * because they have their own refusals; only their harmless values pass.
 */
export const SERVICE_KEYS: ReadonlySet<string> = new Set([
  'image',
  'build',
  'command',
  'entrypoint',
  'environment',
  'env_file',
  'depends_on',
  'healthcheck',
  'volumes',
  'ports',
  'expose',
  'networks',
  'restart',
  'working_dir',
  'user',
  'labels',
  'profiles',
  'deploy',
  'extends',
  'network_mode',
  'privileged',
  'cap_add',
  'devices',
  'pid',
  'ipc',
]);

export const BUILD_KEYS: ReadonlySet<string> = new Set(['context', 'dockerfile', 'args', 'target']);
export const HEALTHCHECK_KEYS: ReadonlySet<string> = new Set([
  'test',
  'interval',
  'timeout',
  'retries',
  'start_period',
  'start_interval',
  'disable',
]);
export const DEPENDS_ON_KEYS: ReadonlySet<string> = new Set(['condition', 'required', 'restart']);
export const LONG_VOLUME_KEYS: ReadonlySet<string> = new Set([
  'type',
  'source',
  'target',
  'read_only',
  'bind',
  'volume',
  'tmpfs',
]);
export const BIND_OPTION_KEYS: ReadonlySet<string> = new Set(['create_host_path', 'selinux']);
export const VOLUME_OPTION_KEYS: ReadonlySet<string> = new Set(['nocopy', 'subpath']);
export const TMPFS_OPTION_KEYS: ReadonlySet<string> = new Set(['size', 'mode']);
export const DEPLOY_KEYS: ReadonlySet<string> = new Set(['resources']);
export const RESOURCE_KEYS: ReadonlySet<string> = new Set(['limits', 'reservations']);
export const RESOURCE_LIMIT_KEYS: ReadonlySet<string> = new Set(['cpus', 'memory', 'pids']);
export const RESOURCE_RESERVATION_KEYS: ReadonlySet<string> = new Set(['cpus', 'memory']);
export const SERVICE_NETWORK_KEYS: ReadonlySet<string> = new Set(['aliases']);
export const EXTENDS_KEYS: ReadonlySet<string> = new Set(['file', 'service']);
export const INCLUDE_KEYS: ReadonlySet<string> = new Set(['path', 'env_file', 'project_directory']);
export const ENV_FILE_KEYS: ReadonlySet<string> = new Set(['path', 'required', 'format']);

/** Top-level `volumes` entries: no `name`, no `driver_opts` (a bind in disguise). */
export const TOP_VOLUME_KEYS: ReadonlySet<string> = new Set(['driver', 'labels', 'external']);
export const TOP_NETWORK_KEYS: ReadonlySet<string> = new Set([
  'driver',
  'labels',
  'internal',
  'external',
]);

/** Mount options of a short-form volume. */
export const SHORT_VOLUME_MODES: ReadonlySet<string> = new Set(['ro', 'rw', 'z', 'Z', 'nocopy']);

/** Compose ignores `x-*` fields. They are accepted (anchors live there) and dropped. */
export function isExtensionKey(key: string): boolean {
  return key.startsWith('x-');
}
