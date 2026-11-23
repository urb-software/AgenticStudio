import {
  BIND_OPTION_KEYS,
  BUILD_KEYS,
  DEPENDS_ON_KEYS,
  DEPLOY_KEYS,
  ENV_FILE_KEYS,
  EXTENDS_KEYS,
  HEALTHCHECK_KEYS,
  isExtensionKey,
  LONG_VOLUME_KEYS,
  RESOURCE_KEYS,
  RESOURCE_LIMIT_KEYS,
  RESOURCE_RESERVATION_KEYS,
  SERVICE_KEYS,
  SERVICE_NETWORK_KEYS,
  SHORT_VOLUME_MODES,
  TMPFS_OPTION_KEYS,
  VOLUME_OPTION_KEYS,
} from './allow-list.js';
import {
  isObj,
  isScalarList,
  isScalarMap,
  isScalarValue,
  isStringList,
  type Judge,
  type Obj,
} from './judge.js';
import { isDockerSocketPath, judgeJoined, judgePath } from './paths.js';
import type { Path } from './parse.js';

/** What a service may refer to. Names are those of the file, never looked up on a prototype. */
export interface Declared {
  services: ReadonlySet<string>;
  volumes: ReadonlySet<string>;
  networks: ReadonlySet<string>;
}

/** Fields whose value must be known now, so a `$` in them is refused. */
const JUDGED_FIELDS: ReadonlySet<string> = new Set([
  'build',
  'env_file',
  'extends',
  'volumes',
  'networks',
  'network_mode',
  'privileged',
  'cap_add',
  'devices',
  'pid',
  'ipc',
]);

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Judges one service and returns the places of its published ports. */
export function judgeService(
  judge: Judge,
  service: Obj,
  path: Path,
  declared: Declared,
): { removedPorts: Path[] } {
  const removedPorts: Path[] = [];
  for (const [key, value] of Object.entries(service)) {
    const at = [...path, key];
    if (isExtensionKey(key)) continue;
    if (!SERVICE_KEYS.has(key)) {
      judge.refuse('unknown_key', at);
      continue;
    }
    if (JUDGED_FIELDS.has(key) && judge.interpolated(value, at)) continue;
    const invalid = (where: Path = at): void => judge.refuse('invalid_value', where);

    switch (key) {
      case 'image':
      case 'restart':
      case 'working_dir':
        if (typeof value !== 'string') invalid();
        break;
      case 'user':
        if (typeof value !== 'string' && typeof value !== 'number') invalid();
        break;
      case 'command':
      case 'entrypoint':
        if (typeof value !== 'string' && !isScalarList(value)) invalid();
        break;
      case 'expose':
        if (!isScalarList(value)) invalid();
        break;
      case 'profiles':
        if (!isStringList(value)) invalid();
        break;
      case 'environment':
      case 'labels':
        // Values stay unjudged and are never echoed. Only the shape is checked.
        if (!isScalarMap(value) && !isStringList(value)) invalid();
        break;
      case 'healthcheck':
        judgeHealthcheck(judge, value, at);
        break;
      case 'deploy':
        judgeDeploy(judge, value, at);
        break;
      case 'depends_on':
        judgeDependsOn(judge, value, at, declared);
        break;
      case 'build':
        judgeBuild(judge, value, at);
        break;
      case 'env_file':
        judgeEnvFile(judge, value, at);
        break;
      case 'extends':
        judgeExtends(judge, value, at, declared);
        break;
      case 'volumes':
        judgeVolumes(judge, value, at, declared);
        break;
      case 'networks':
        judgeNetworks(judge, value, at, declared);
        break;
      case 'ports':
        if (!Array.isArray(value)) {
          invalid();
          break;
        }
        value.forEach((entry, index) => {
          if (isScalarValue(entry) || isObj(entry)) removedPorts.push([...at, index]);
          else invalid([...at, index]);
        });
        break;
      case 'network_mode':
        judgeNetworkMode(judge, value, at, declared);
        break;
      case 'pid':
      case 'ipc':
        if (typeof value === 'string' && value.toLowerCase() === 'host') {
          judge.refuse('host_namespace', at);
        } else {
          judge.refuse('unknown_key', at);
        }
        break;
      case 'privileged':
        if (value !== false) judge.refuse('privileged', at);
        break;
      case 'cap_add':
      case 'devices':
        if (!Array.isArray(value)) invalid();
        else
          value.forEach((_entry, index) =>
            judge.refuse(key === 'cap_add' ? 'capability_added' : 'device', [...at, index]),
          );
        break;
    }
  }
  return { removedPorts };
}

function judgeHealthcheck(judge: Judge, value: unknown, path: Path): void {
  if (!isObj(value)) return judge.refuse('invalid_value', path);
  judge.onlyKeys(value, HEALTHCHECK_KEYS, path);
  for (const [key, item] of Object.entries(value)) {
    const valid =
      key === 'test' ? typeof item === 'string' || isScalarList(item) : isScalarValue(item);
    if (HEALTHCHECK_KEYS.has(key) && !valid) judge.refuse('invalid_value', [...path, key]);
  }
}

function judgeDeploy(judge: Judge, value: unknown, path: Path): void {
  if (!isObj(value)) return judge.refuse('invalid_value', path);
  judge.onlyKeys(value, DEPLOY_KEYS, path);
  const resources = value.resources;
  if (resources === undefined) return;
  const at = [...path, 'resources'];
  if (!isObj(resources)) return judge.refuse('invalid_value', at);
  judge.onlyKeys(resources, RESOURCE_KEYS, at);
  for (const [group, allowed] of [
    ['limits', RESOURCE_LIMIT_KEYS],
    ['reservations', RESOURCE_RESERVATION_KEYS],
  ] as const) {
    const section = resources[group];
    if (section === undefined) continue;
    const where = [...at, group];
    if (!isObj(section)) {
      judge.refuse('invalid_value', where);
      continue;
    }
    judge.onlyKeys(section, allowed, where);
    for (const [key, item] of Object.entries(section)) {
      if (allowed.has(key) && !isScalarValue(item)) judge.refuse('invalid_value', [...where, key]);
    }
  }
}

function judgeDependsOn(judge: Judge, value: unknown, path: Path, declared: Declared): void {
  const known = (name: string): boolean => declared.services.has(name);
  if (isStringList(value)) {
    value.forEach((name, index) => {
      if (!known(name)) judge.refuse('invalid_value', [...path, index]);
    });
    return;
  }
  if (!isObj(value)) return judge.refuse('invalid_value', path);
  for (const [name, entry] of Object.entries(value)) {
    const at = [...path, name];
    if (!known(name)) judge.refuse('invalid_value', at);
    if (entry === null) continue;
    if (!isObj(entry)) {
      judge.refuse('invalid_value', at);
      continue;
    }
    judge.onlyKeys(entry, DEPENDS_ON_KEYS, at);
    for (const [key, item] of Object.entries(entry)) {
      if (DEPENDS_ON_KEYS.has(key) && !isScalarValue(item)) {
        judge.refuse('invalid_value', [...at, key]);
      }
    }
  }
}

/** A path that must stay inside the source directory (a build context, an env file, ...). */
function judgeSourcePath(judge: Judge, value: unknown, path: Path): void {
  if (typeof value !== 'string') return judge.refuse('invalid_value', path);
  if (judgePath(value) === 'outside') judge.refuse('path_outside_source', path);
}

/** A build context is `.` or starts with `./`: anything else may be read as a remote one. */
function judgeContext(judge: Judge, value: unknown, path: Path): void {
  if (typeof value !== 'string') return judge.refuse('invalid_value', path);
  if (judgePath(value) === 'outside') return judge.refuse('path_outside_source', path);
  if (value !== '.' && !value.startsWith('./')) judge.refuse('build_context_not_local', path);
}

function judgeBuild(judge: Judge, value: unknown, path: Path): void {
  if (typeof value === 'string') return judgeContext(judge, value, path);
  if (!isObj(value)) return judge.refuse('invalid_value', path);
  judge.onlyKeys(value, BUILD_KEYS, path);
  const { context, dockerfile, args, target } = value;
  const baseContext = typeof context === 'string' ? context : '.';
  // A context that is itself outside is refused once, below; the Dockerfile is judged against it.
  const contextOutside = judgePath(baseContext) === 'outside';
  if (context !== undefined) judgeContext(judge, context, [...path, 'context']);
  if (dockerfile !== undefined) {
    const at = [...path, 'dockerfile'];
    if (typeof dockerfile !== 'string') judge.refuse('invalid_value', at);
    else if (!contextOutside && judgeJoined(baseContext, dockerfile) === 'outside') {
      judge.refuse('path_outside_source', at);
    }
  }
  if (target !== undefined && typeof target !== 'string') {
    judge.refuse('invalid_value', [...path, 'target']);
  }
  if (args !== undefined && !isScalarMap(args) && !isStringList(args)) {
    judge.refuse('invalid_value', [...path, 'args']);
  }
}

function judgeEnvFile(judge: Judge, value: unknown, path: Path): void {
  if (typeof value === 'string') return judgeSourcePath(judge, value, path);
  if (!Array.isArray(value)) return judge.refuse('invalid_value', path);
  value.forEach((entry, index) => {
    const at = [...path, index];
    if (typeof entry === 'string') return judgeSourcePath(judge, entry, at);
    if (!isObj(entry)) return judge.refuse('invalid_value', at);
    judge.onlyKeys(entry, ENV_FILE_KEYS, at);
    judgeSourcePath(judge, entry.path, [...at, 'path']);
  });
}

function judgeExtends(judge: Judge, value: unknown, path: Path, declared: Declared): void {
  if (typeof value === 'string') {
    if (!declared.services.has(value)) judge.refuse('invalid_value', path);
    return;
  }
  if (!isObj(value)) return judge.refuse('invalid_value', path);
  judge.onlyKeys(value, EXTENDS_KEYS, path);
  const { file, service } = value;
  if (typeof service !== 'string') judge.refuse('invalid_value', [...path, 'service']);
  if (file !== undefined) {
    judge.refuse('external_file', [...path, 'file']);
  } else if (typeof service === 'string' && !declared.services.has(service)) {
    judge.refuse('invalid_value', [...path, 'service']);
  }
}

function judgeNetworkMode(judge: Judge, value: unknown, path: Path, declared: Declared): void {
  if (typeof value !== 'string') return judge.refuse('invalid_value', path);
  if (value.toLowerCase() === 'host') return judge.refuse('host_namespace', path);
  if (value === 'none') return;
  if (value.startsWith('service:') && declared.services.has(value.slice('service:'.length))) {
    return;
  }
  judge.refuse('unknown_key', path);
}

function judgeNetworks(judge: Judge, value: unknown, path: Path, declared: Declared): void {
  const known = (name: string): boolean => name === 'default' || declared.networks.has(name);
  if (isStringList(value)) {
    value.forEach((name, index) => {
      if (!known(name)) judge.refuse('invalid_value', [...path, index]);
    });
    return;
  }
  if (!isObj(value)) return judge.refuse('invalid_value', path);
  for (const [name, entry] of Object.entries(value)) {
    const at = [...path, name];
    if (!known(name)) judge.refuse('invalid_value', at);
    if (entry === null) continue;
    if (!isObj(entry)) {
      judge.refuse('invalid_value', at);
      continue;
    }
    judge.onlyKeys(entry, SERVICE_NETWORK_KEYS, at);
    if (entry.aliases !== undefined && !isStringList(entry.aliases)) {
      judge.refuse('invalid_value', [...at, 'aliases']);
    }
  }
}

function judgeVolumes(judge: Judge, value: unknown, path: Path, declared: Declared): void {
  if (!Array.isArray(value)) return judge.refuse('invalid_value', path);
  value.forEach((entry, index) => {
    const at = [...path, index];
    if (typeof entry === 'string') judgeShortVolume(judge, entry, at, declared);
    else if (isObj(entry)) judgeLongVolume(judge, entry, at, declared);
    else judge.refuse('invalid_value', at);
  });
}

function isBindSource(source: string): boolean {
  return source.startsWith('.') || source.startsWith('~') || /[/\\]/.test(source);
}

/** A named volume must be declared at the top level of the file. */
function judgeNamedVolume(judge: Judge, name: string, path: Path, declared: Declared): void {
  if (!VOLUME_NAME.test(name) || !declared.volumes.has(name)) judge.refuse('invalid_value', path);
}

function judgeShortVolume(judge: Judge, spec: string, path: Path, declared: Declared): void {
  if (isDockerSocketPath(spec)) return judge.refuse('docker_socket', path);
  const parts = spec.split(':');
  if (parts.length > 3) return judge.refuse('invalid_value', path);
  const [first = '', second, mode] = parts;
  const target = second ?? first;
  if (!target.startsWith('/')) return judge.refuse('invalid_value', path);
  if (mode !== undefined && !mode.split(',').every((option) => SHORT_VOLUME_MODES.has(option))) {
    return judge.refuse('invalid_value', path);
  }
  if (second === undefined) return; // An anonymous volume.
  if (first === '') return judge.refuse('invalid_value', path);
  if (isBindSource(first)) {
    if (judgePath(first) === 'outside') judge.refuse('mount_outside_source', path);
    return;
  }
  judgeNamedVolume(judge, first, path, declared);
}

function judgeLongVolume(judge: Judge, entry: Obj, path: Path, declared: Declared): void {
  const { type, source, target } = entry;
  judge.onlyKeys(entry, LONG_VOLUME_KEYS, path);
  for (const value of [source, target]) {
    if (typeof value === 'string' && isDockerSocketPath(value)) {
      return judge.refuse('docker_socket', path);
    }
  }
  if (typeof target !== 'string' || !target.startsWith('/')) {
    judge.refuse('invalid_value', [...path, 'target']);
  }
  if (entry.read_only !== undefined && typeof entry.read_only !== 'boolean') {
    judge.refuse('invalid_value', [...path, 'read_only']);
  }
  judgeVolumeOptions(judge, entry, path);

  if (type === 'bind') {
    if (typeof source !== 'string') judge.refuse('invalid_value', [...path, 'source']);
    else if (judgePath(source) === 'outside') judge.refuse('mount_outside_source', path);
  } else if (type === 'volume') {
    if (source === undefined) return; // An anonymous volume.
    if (typeof source !== 'string') judge.refuse('invalid_value', [...path, 'source']);
    else judgeNamedVolume(judge, source, [...path, 'source'], declared);
  } else if (type === 'tmpfs') {
    if (source !== undefined) judge.refuse('invalid_value', [...path, 'source']);
  } else {
    judge.refuse('invalid_value', [...path, 'type']);
  }
}

function judgeVolumeOptions(judge: Judge, entry: Obj, path: Path): void {
  for (const [name, allowed] of [
    ['bind', BIND_OPTION_KEYS],
    ['volume', VOLUME_OPTION_KEYS],
    ['tmpfs', TMPFS_OPTION_KEYS],
  ] as const) {
    const options = entry[name];
    if (options === undefined) continue;
    const at = [...path, name];
    if (!isObj(options)) {
      judge.refuse('invalid_value', at);
      continue;
    }
    judge.onlyKeys(options, allowed, at);
    for (const [key, item] of Object.entries(options)) {
      if (!allowed.has(key)) continue;
      const subpath = name === 'volume' && key === 'subpath';
      if (subpath && typeof item === 'string') {
        if (judgePath(item) === 'outside') judge.refuse('mount_outside_source', [...at, key]);
      } else if (!isScalarValue(item)) {
        judge.refuse('invalid_value', [...at, key]);
      }
    }
  }
}
