import { LineCounter, isMap, isScalar, parseDocument, visit, type Document } from 'yaml';
import type { RefusalCode } from './refusal.js';

/** Path into the document: keys and sequence indexes. */
export type Path = readonly (string | number)[];

export const MAX_TEXT_BYTES = 256 * 1024;
/** Alias expansion cap (`yaml` counts the nodes an alias pulls in). Real stacks use a handful. */
const MAX_ALIAS_COUNT = 100;

/** Tags of the YAML core schema. Any other tag is a custom tag and is refused. */
const CORE_TAGS: ReadonlySet<string> = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:merge',
]);

export interface ParseProblem {
  code: RefusalCode;
  path: Path;
  line?: number;
}

export type ParseResult =
  | { ok: true; value: Record<string, unknown>; lineOf: (path: Path) => number | undefined }
  | { ok: false; problems: ParseProblem[] };

/**
 * Parses the text and resolves anchors, aliases and merge keys, so the rules judge the document
 * Compose would see. Fails closed: tags, several documents, a document that is not a mapping,
 * duplicate keys, non-string keys and alias bombs are all refused.
 */
export function parseCompose(text: string): ParseResult {
  const lineCounter = new LineCounter();
  let doc: Document.Parsed;
  try {
    doc = parseDocument(text, {
      version: '1.2',
      schema: 'core',
      merge: true,
      uniqueKeys: true,
      lineCounter,
    });
  } catch {
    return { ok: false, problems: [{ code: 'yaml_syntax', path: [] }] };
  }

  const problems: ParseProblem[] = [];
  for (const error of doc.errors) {
    problems.push({ code: errorCode(error.code), path: [], line: error.linePos?.[0].line });
  }
  for (const warning of doc.warnings) {
    problems.push({
      code: warning.code === 'TAG_RESOLVE_FAILED' ? 'custom_tag' : 'yaml_syntax',
      path: [],
      line: warning.linePos?.[0].line,
    });
  }

  const lineAt = (offset: number | undefined): number | undefined =>
    offset === undefined ? undefined : lineCounter.linePos(offset).line;

  visit(doc, {
    Node(_key, node) {
      if ('tag' in node && node.tag && !CORE_TAGS.has(node.tag)) {
        problems.push({ code: 'custom_tag', path: [], line: lineAt(node.range?.[0]) });
      }
    },
    Pair(_key, pair) {
      const key = pair.key;
      // `yaml` reads the merge key `<<` as a scalar whose value is a symbol.
      const isMerge = isScalar(key) && typeof key.value === 'symbol';
      if (!isMerge && !(isScalar(key) && typeof key.value === 'string')) {
        const offset = isScalar(key) ? key.range?.[0] : undefined;
        problems.push({ code: 'invalid_value', path: [], line: lineAt(offset) });
      }
    },
  });

  // `parseDocument` reports a second document as an error; the document must also be a mapping.
  if (!isMap(doc.contents)) {
    problems.push({ code: 'not_a_mapping', path: [] });
  }
  if (problems.length > 0) return { ok: false, problems: dedupe(problems) };

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    const excessive = error instanceof Error && /excessive alias/i.test(error.message);
    return {
      ok: false,
      problems: [{ code: excessive ? 'alias_limit' : 'yaml_syntax', path: [] }],
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: [{ code: 'not_a_mapping', path: [] }] };
  }

  return {
    ok: true,
    value: value as Record<string, unknown>,
    lineOf: (path) => lineOfPath(doc, lineCounter, path),
  };
}

function errorCode(code: string): RefusalCode {
  if (code === 'DUPLICATE_KEY') return 'duplicate_key';
  if (code === 'MULTIPLE_DOCS') return 'not_a_mapping';
  if (code === 'TAG_RESOLVE_FAILED') return 'custom_tag';
  return 'yaml_syntax';
}

function dedupe(problems: ParseProblem[]): ParseProblem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const id = `${problem.code}:${problem.line ?? ''}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * The line of the deepest node of the path that the source text holds. Content that came from an
 * alias or a merge key has no node of its own, so the line of its closest ancestor is used.
 */
function lineOfPath(
  doc: Document.Parsed,
  lineCounter: LineCounter,
  path: Path,
): number | undefined {
  for (let length = path.length; length >= 0; length -= 1) {
    try {
      const node = doc.getIn(path.slice(0, length), true);
      const offset =
        typeof node === 'object' && node !== null && 'range' in node
          ? (node as { range?: [number, number, number] | null }).range?.[0]
          : undefined;
      if (offset !== undefined) return lineCounter.linePos(offset).line;
    } catch {
      // Try the parent.
    }
  }
  return undefined;
}
