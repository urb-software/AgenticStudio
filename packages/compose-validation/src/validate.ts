import {
  INCLUDE_KEYS,
  isExtensionKey,
  TOP_LEVEL_KEYS,
  TOP_NETWORK_KEYS,
  TOP_VOLUME_KEYS,
} from './allow-list.js';
import { Judge, isObj, isScalarValue, isStringList, type Obj } from './judge.js';
import { judgePath } from './paths.js';
import { MAX_TEXT_BYTES, parseCompose, type Path } from './parse.js';
import { REFUSAL_MESSAGES, type Refusal } from './refusal.js';
import { judgeService, type Declared } from './service.js';

export const MAX_SERVICES = 20;
export { MAX_TEXT_BYTES };

export interface ComposeInput {
  /** The text of the Compose file. */
  text: string;
  /** The service the Preview routes to. */
  entryService: string;
  /** The port of that service the Preview routes to. */
  entryPort: number;
}

/** The normalised document: anchors resolved, published ports and `x-*` fields removed. */
export type ComposeStack = Record<string, unknown>;

export interface RemovedPort {
  service: string;
  /** For example `services.web.ports[0]`. */
  place: string;
}

export type ComposeResult =
  | { status: 'accepted'; stack: ComposeStack; removedPorts: RemovedPort[] }
  | { status: 'refused'; refusals: Refusal[] };

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Judges a Compose file. A pure function: it reads no file, starts no process and needs no
 * Docker. It fails closed: whatever it cannot judge is refused, and so is any error it hits.
 */
export function validateCompose(input: ComposeInput): ComposeResult {
  try {
    return judge(input);
  } catch {
    return refused([
      { code: 'unjudgeable', place: '(document)', message: REFUSAL_MESSAGES.unjudgeable },
    ]);
  }
}

function refused(refusals: Refusal[]): ComposeResult {
  return { status: 'refused', refusals };
}

function judge(input: ComposeInput): ComposeResult {
  const { text, entryService, entryPort } = input;
  if (typeof text !== 'string') throw new TypeError('text');
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    return refused([
      { code: 'text_too_large', place: '(document)', message: REFUSAL_MESSAGES.text_too_large },
    ]);
  }

  const parsed = parseCompose(text);
  if (!parsed.ok) {
    return refused(
      parsed.problems.map((problem) => {
        const refusal: Refusal = {
          code: problem.code,
          place: problem.path.length === 0 ? '(document)' : problem.path.join('.'),
          message: REFUSAL_MESSAGES[problem.code],
        };
        if (problem.line !== undefined) refusal.line = problem.line;
        return refusal;
      }),
    );
  }

  const stack = parsed.value;
  const judged = new Judge(parsed.lineOf);
  refuseProtoKeys(judged, stack, []);
  judgeDocument(judged, stack, entryService);

  if (!Number.isInteger(entryPort) || entryPort < 1 || entryPort > 65535) {
    judged.refuse('entry_port_invalid', ['entryPort'], null);
  }
  if (judged.refusals.length > 0) return refused(judged.refusals);

  const removedPorts = normalise(stack);
  return { status: 'accepted', stack, removedPorts };
}

/** `__proto__` as a key is never meaningful in a Compose file and unsafe in a plain object. */
function refuseProtoKeys(judged: Judge, value: unknown, path: Path): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => refuseProtoKeys(judged, item, [...path, index]));
  } else if (isObj(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__') judged.refuse('unknown_key', [...path, key]);
      else refuseProtoKeys(judged, item, [...path, key]);
    }
  }
}

function judgeDocument(judged: Judge, doc: Obj, entryService: string): void {
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key) && !isExtensionKey(key)) judged.refuse('unknown_key', [key]);
  }
  if (doc.name !== undefined && (typeof doc.name !== 'string' || !PROJECT_NAME.test(doc.name))) {
    judged.refuse('invalid_value', ['name']);
  }
  if (
    doc.version !== undefined &&
    typeof doc.version !== 'string' &&
    typeof doc.version !== 'number'
  ) {
    judged.refuse('invalid_value', ['version']);
  }

  const volumes = judgeTopLevelMap(judged, doc, 'volumes', TOP_VOLUME_KEYS, judgeTopVolume);
  const networks = judgeTopLevelMap(judged, doc, 'networks', TOP_NETWORK_KEYS, judgeTopNetwork);
  judgeInclude(judged, doc.include);

  const services = doc.services;
  if (services !== undefined && !isObj(services)) {
    judged.refuse('invalid_value', ['services']);
  }
  const serviceMap: Obj = isObj(services) ? services : {};
  const names = Object.keys(serviceMap);
  if (names.length > MAX_SERVICES) judged.refuse('too_many_services', ['services']);

  const declared: Declared = { services: new Set(names), volumes, networks };
  for (const [name, service] of Object.entries(serviceMap)) {
    const at = ['services', name];
    if (!SERVICE_NAME.test(name) || !isObj(service)) {
      judged.refuse('invalid_value', at);
      continue;
    }
    judgeService(judged, service, at, declared);
  }

  if (typeof entryService !== 'string' || !Object.hasOwn(serviceMap, entryService)) {
    judged.refuse('entry_service_missing', ['services']);
  }
}

/** Judges a top-level `volumes` or `networks` mapping and returns the names it declares. */
function judgeTopLevelMap(
  judged: Judge,
  doc: Obj,
  field: 'volumes' | 'networks',
  allowed: ReadonlySet<string>,
  judgeEntry: (judged: Judge, entry: Obj, path: Path) => void,
): Set<string> {
  const value = doc[field];
  if (value === undefined || value === null) return new Set();
  if (!isObj(value)) {
    judged.refuse('invalid_value', [field]);
    return new Set();
  }
  if (judged.interpolated(value, [field])) return new Set(Object.keys(value));
  for (const [name, entry] of Object.entries(value)) {
    const at = [field, name];
    if (entry === null) continue;
    if (!isObj(entry)) {
      judged.refuse('invalid_value', at);
      continue;
    }
    judged.onlyKeys(entry, allowed, at);
    if (entry.labels !== undefined && !isStringList(entry.labels) && !isScalarMap(entry.labels)) {
      judged.refuse('invalid_value', [...at, 'labels']);
    }
    judgeEntry(judged, entry, at);
  }
  return new Set(Object.keys(value));
}

function isScalarMap(value: unknown): boolean {
  return isObj(value) && Object.values(value).every(isScalarValue);
}

function judgeTopVolume(judged: Judge, entry: Obj, path: Path): void {
  if (entry.external !== undefined && entry.external !== false) {
    judged.refuse('external_volume', [...path, 'external']);
  }
  if (entry.driver !== undefined && entry.driver !== 'local') {
    judged.refuse('invalid_value', [...path, 'driver']);
  }
}

function judgeTopNetwork(judged: Judge, entry: Obj, path: Path): void {
  if (entry.external !== undefined && entry.external !== false) {
    judged.refuse('external_network', [...path, 'external']);
  }
  const { driver, internal } = entry;
  if (typeof driver === 'string' && driver.toLowerCase() === 'host') {
    judged.refuse('host_namespace', [...path, 'driver']);
  } else if (driver !== undefined && driver !== 'bridge') {
    judged.refuse('invalid_value', [...path, 'driver']);
  }
  if (internal !== undefined && typeof internal !== 'boolean') {
    judged.refuse('invalid_value', [...path, 'internal']);
  }
}

function judgeInclude(judged: Judge, include: unknown): void {
  if (include === undefined) return;
  const path = ['include'];
  if (judged.interpolated(include, path)) return;
  if (!Array.isArray(include)) return judged.refuse('invalid_value', path);
  include.forEach((entry, index) => {
    const at = [...path, index];
    if (typeof entry === 'string') return judgeIncludePath(judged, entry, at);
    if (!isObj(entry)) return judged.refuse('invalid_value', at);
    judged.onlyKeys(entry, INCLUDE_KEYS, at);
    for (const key of ['path', 'env_file', 'project_directory']) {
      const value = entry[key];
      if (value === undefined) continue;
      if (typeof value === 'string') judgeIncludePath(judged, value, [...at, key]);
      else if (key !== 'project_directory' && isStringList(value)) {
        value.forEach((item, position) => judgeIncludePath(judged, item, [...at, key, position]));
      } else judged.refuse('invalid_value', [...at, key]);
    }
    if (entry.path === undefined) judged.refuse('invalid_value', [...at, 'path']);
  });
}

function judgeIncludePath(judged: Judge, value: string, path: Path): void {
  if (judgePath(value) === 'outside') judged.refuse('path_outside_source', path);
}

/** Removes `x-*` fields and published ports from the document. Returns the ports removed. */
function normalise(stack: Obj): RemovedPort[] {
  const removed: RemovedPort[] = [];
  for (const key of Object.keys(stack)) {
    if (isExtensionKey(key)) delete stack[key];
  }
  const services = isObj(stack.services) ? stack.services : {};
  for (const [name, service] of Object.entries(services)) {
    if (!isObj(service)) continue;
    for (const key of Object.keys(service)) {
      if (isExtensionKey(key)) delete service[key];
    }
    if (Array.isArray(service.ports)) {
      service.ports.forEach((_port, index) =>
        removed.push({ service: name, place: `services.${name}.ports[${index}]` }),
      );
    }
    delete service.ports;
  }
  return removed;
}
