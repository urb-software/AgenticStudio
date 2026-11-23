import { isExtensionKey, TOP_LEVEL_KEYS, TOP_NETWORK_KEYS, TOP_VOLUME_KEYS } from './allow-list.js';
import { Judge, isObj, isScalarMap, isStringList, placeOf, type Obj } from './judge.js';
import { MAX_NODES, MAX_TEXT_BYTES, parseCompose, type Path } from './parse.js';
import type { Refusal, RefusalCode } from './refusal.js';
import { judgeService, type Declared } from './service.js';

export const MAX_SERVICES = 20;
export { MAX_NODES, MAX_TEXT_BYTES };

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
    return refusedAt('unjudgeable');
  }
}

function refused(refusals: Refusal[]): ComposeResult {
  return { status: 'refused', refusals };
}

/** A refusal about the document as a whole. */
function refusedAt(code: RefusalCode): ComposeResult {
  const judged = new Judge(() => undefined);
  judged.refuse(code, [], null);
  return refused(judged.refusals);
}

/** The size of the text in UTF-8, counted without any global that is not part of the language. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function judge(input: ComposeInput): ComposeResult {
  const { text, entryService, entryPort } = input;
  if (typeof text !== 'string') throw new TypeError('text');
  if (utf8Length(text) > MAX_TEXT_BYTES) return refusedAt('text_too_large');

  const parsed = parseCompose(text);
  if (!parsed.ok) {
    const judged = new Judge(() => undefined);
    for (const problem of parsed.problems) {
      judged.refuse(problem.code, problem.path, problem.line ?? null);
    }
    return refused(judged.refusals);
  }

  const stack = parsed.value;
  const judged = new Judge(parsed.lineOf);
  refuseProtoKeys(judged, stack, []);
  const removedPorts = judgeDocument(judged, stack, entryService);

  if (!Number.isInteger(entryPort) || entryPort < 1 || entryPort > 65535) {
    judged.refuse('entry_port_invalid', ['entryPort'], null);
  }
  if (judged.refusals.length > 0) return refused(judged.refusals);

  normalise(stack);
  return {
    status: 'accepted',
    stack,
    removedPorts: removedPorts.map((path) => ({ service: String(path[1]), place: placeOf(path) })),
  };
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

/** Judges the document. Returns the places of the published ports, for every service. */
function judgeDocument(judged: Judge, doc: Obj, entryService: string): Path[] {
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
  if (doc.include !== undefined) judged.refuse('external_file', ['include']);

  const services = doc.services;
  if (services !== undefined && !isObj(services)) {
    judged.refuse('invalid_value', ['services']);
  }
  const serviceMap: Obj = isObj(services) ? services : {};
  const names = Object.keys(serviceMap);
  if (names.length > MAX_SERVICES) judged.refuse('too_many_services', ['services']);

  const declared: Declared = { services: new Set(names), volumes, networks };
  const removedPorts: Path[] = [];
  for (const [name, service] of Object.entries(serviceMap)) {
    const at = ['services', name];
    if (!SERVICE_NAME.test(name) || !isObj(service)) {
      judged.refuse('invalid_value', at);
      continue;
    }
    removedPorts.push(...judgeService(judged, service, at, declared).removedPorts);
  }

  if (typeof entryService !== 'string' || !Object.hasOwn(serviceMap, entryService)) {
    judged.refuse('entry_service_missing', ['services']);
  }
  return removedPorts;
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
    if (field === 'networks' && ['host', 'bridge', 'none'].includes(name)) {
      judged.refuse(name === 'host' ? 'host_namespace' : 'invalid_value', at);
    }
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

/** Removes `name`, `x-*` fields and published ports from the document. */
function normalise(stack: Obj): void {
  delete stack.name;
  for (const key of Object.keys(stack)) {
    if (isExtensionKey(key)) delete stack[key];
  }
  const services = isObj(stack.services) ? stack.services : {};
  for (const service of Object.values(services)) {
    if (!isObj(service)) continue;
    for (const key of Object.keys(service)) {
      if (isExtensionKey(key)) delete service[key];
    }
    delete service.ports;
  }
}
