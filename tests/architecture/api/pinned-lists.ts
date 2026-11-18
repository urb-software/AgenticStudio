import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { listDirectories, listFiles } from '../harness';
import { CHILD_ENTITIES, ENTITY_FILE } from './aggregate-rules';
import {
  exportedClasses,
  exportedLater,
  hasExportModifier,
  isErrorClass,
  parse,
  repositoryContract,
} from './syntax';

/**
 * The three pinned lists of `architecture:api` (docs/engineering/quality.md §4, Issue #170).
 *
 * Some rules of docs/architecture/backend.md §3 cannot be judged by a gate check: "no business
 * rule is written in the database adapter" (rule 6), "shared application logic is the last
 * resort" (rule 3) and "anything with its own repository is an aggregate root" (rule 11). Each
 * has a plain record in `tests/architecture/api/pinned/` that the test compares with the source:
 * a change to the source fails until the record is changed in the same pull request, so the
 * reviewer cannot miss it. The records state decisions. They are never an allowlist that makes a
 * gate violation pass, and a gate check is not relaxed because something is recorded here.
 */

/** Where the records live, relative to the repository root (the paths the messages name). */
export const PINNED_DIRECTORY = 'tests/architecture/api/pinned';
const METHODS_FILE = 'repository-methods.json';
const COLLABORATORS_FILE = 'application-collaborators.json';
const ROOTS_FILE = 'aggregate-roots.json';

/** What a repository method does; `atomic` and `set-wide` need a one-line reason. */
export const METHOD_KINDS = ['load', 'save', 'query', 'atomic', 'set-wide'] as const;
const KINDS_NEEDING_A_REASON: readonly string[] = ['atomic', 'set-wide'];

export interface RepositoryMethodRecord {
  kind: string;
  reason?: string;
}
export interface RepositoryMethodsFile {
  /** `<module>/<InterfaceName>` → method name → what it is. */
  repositories: Record<string, Record<string, RepositoryMethodRecord>>;
}
export interface CollaboratorsFile {
  /** `<module>/application/<file>.ts` → the step of rule 3 that was tried and why it did not apply. */
  collaborators: Record<string, { reason: string }>;
}
export interface AggregateRootsFile {
  /** `<module>/<RootClass>` → the one-line reason it is an aggregate root. */
  roots: Record<string, { reason: string }>;
}

function isProductionTypeScript(path: string): boolean {
  return (
    /\.tsx?$/.test(path) &&
    !path.endsWith('.d.ts') &&
    !/(^|\/)__tests__\//.test(path) &&
    !/\.(test|spec)\.tsx?$/.test(path)
  );
}

/**
 * The method names of every exported `…Repository` interface (or type literal alias, exported where
 * declared or by a later `export { X }`) in `domain/repositories/`, keyed
 * `<module>/<InterfaceName>`. A method is a method signature or a property typed as a function;
 * an overloaded method counts once.
 */
export function repositoryInterfaces(baseDir: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const module of listDirectories(baseDir, 'src/modules')) {
    const directory = `src/modules/${module}/domain/repositories`;
    for (const path of listFiles(baseDir, directory).filter(isProductionTypeScript)) {
      const source = parse(baseDir, path);
      const later = exportedLater(source);
      for (const statement of source.statements) {
        const repository = repositoryContract(statement);
        if (
          !repository ||
          !/Repository$/.test(repository.name) ||
          !(hasExportModifier(statement) || later.has(repository.name))
        ) {
          continue;
        }
        found[`${module}/${repository.name}`] = [
          ...new Set(repository.members.flatMap(memberName)),
        ].sort();
      }
    }
  }
  return found;
}

/** A method, or a property whose type is a function (`find: (id: string) => …`). */
function memberName(member: ts.TypeElement): string[] {
  const isMethod =
    ts.isMethodSignature(member) ||
    (ts.isPropertySignature(member) &&
      member.type !== undefined &&
      ts.isFunctionTypeNode(member.type));
  if (!isMethod || !member.name) return [];
  return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? [member.name.text] : [];
}

/** The files directly in a module's `application/` folder, as `<module>/application/<file>`. */
export function applicationCollaborators(baseDir: string): string[] {
  return listDirectories(baseDir, 'src/modules')
    .flatMap((module) =>
      listFiles(baseDir, `src/modules/${module}/application`)
        .filter((path) => !path.slice(`src/modules/${module}/application/`.length).includes('/'))
        .filter(isProductionTypeScript)
        .map((path) => path.slice('src/modules/'.length)),
    )
    .sort();
}

/**
 * The aggregate roots of every module, keyed `<module>/<RootClass>`: the class each file in
 * `domain/entities/` exports, except the child entities pinned in `aggregate-rules.ts` (they have
 * an identity only within their root). A file with no entity class is keyed by its file name.
 */
export function aggregateRoots(baseDir: string): Record<string, string> {
  const children = new Set(Object.values(CHILD_ENTITIES).flat());
  const found: Record<string, string> = {};
  for (const module of listDirectories(baseDir, 'src/modules')) {
    for (const path of listFiles(baseDir, `src/modules/${module}/domain/entities`)) {
      if (!ENTITY_FILE.test(path) || !isProductionTypeScript(path) || children.has(path)) continue;
      const entity = exportedClasses(parse(baseDir, path)).find(
        (exported) => !isErrorClass(exported),
      );
      const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.ts$/, '');
      found[`${module}/${entity?.name ?? stem}`] = path;
    }
  }
  return found;
}

/**
 * What differs between the source under `baseDir` and the records in `pinnedDirectory`, each as a
 * message that says which file to update and why. Empty when the records match.
 */
export function pinnedListProblems(baseDir: string, pinnedDirectory: string): string[] {
  return [
    ...repositoryMethodProblems(baseDir, pinnedDirectory),
    ...collaboratorProblems(baseDir, pinnedDirectory),
    ...aggregateRootProblems(baseDir, pinnedDirectory),
  ];
}

function readRecord<T>(pinnedDirectory: string, name: string): T | string {
  const file = join(pinnedDirectory, name);
  if (!existsSync(file)) {
    return `${PINNED_DIRECTORY}/${name} is missing. Restore it from version control: the pinned lists are checked in.`;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return `${PINNED_DIRECTORY}/${name} is not valid JSON.`;
  }
}

function hasReason(entry: { reason?: unknown } | undefined): boolean {
  return typeof entry?.reason === 'string' && entry.reason.trim() !== '';
}

function repositoryMethodProblems(baseDir: string, pinnedDirectory: string): string[] {
  const record = readRecord<RepositoryMethodsFile>(pinnedDirectory, METHODS_FILE);
  if (typeof record === 'string') return [record];
  const recorded = record.repositories ?? {};
  const actual = repositoryInterfaces(baseDir);
  const file = `${PINNED_DIRECTORY}/${METHODS_FILE}`;
  const how =
    `Update ${file} in this pull request: list every method with its kind (${METHOD_KINDS.join(', ')}), ` +
    'and give each atomic or set-wide method a one-line reason it cannot be a load, a call on the ' +
    'domain object and a save. A repository that gains methods usually holds a business rule that ' +
    'belongs on an entity or value object (backend.md §3 rule 6); say in the review notes why ' +
    'this one is the exception.';
  const problems: string[] = [];

  for (const name of Object.keys(actual).sort()) {
    const methods = actual[name] ?? [];
    const pinned = recorded[name];
    if (!pinned) {
      problems.push(
        `Repository interface ${name} is not recorded (methods: ${methods.join(', ')}). ${how}`,
      );
      continue;
    }
    for (const method of methods.filter((m) => !(m in pinned))) {
      problems.push(`${name} gained the method "${method}", which is not recorded. ${how}`);
    }
    for (const method of Object.keys(pinned).filter((m) => !methods.includes(m))) {
      problems.push(
        `${name} no longer has the method "${method}" (removed or renamed), which is still recorded. ${how}`,
      );
    }
    for (const [method, entry] of Object.entries(pinned)) {
      if (!(METHOD_KINDS as readonly string[]).includes(entry.kind)) {
        problems.push(
          `${name}.${method} has the kind "${entry.kind}"; use one of ${METHOD_KINDS.join(', ')}. Fix ${file}.`,
        );
      } else if (KINDS_NEEDING_A_REASON.includes(entry.kind) && !hasReason(entry)) {
        problems.push(
          `${name}.${method} is ${entry.kind} and has no "reason". Give a one-line reason in ${file}: ` +
            'why this operation cannot be a load, a call on the domain object and a save.',
        );
      }
    }
  }
  for (const name of Object.keys(recorded)
    .filter((n) => !(n in actual))
    .sort()) {
    problems.push(`${name} is recorded but no repository interface of that name exists. ${how}`);
  }
  return problems;
}

function collaboratorProblems(baseDir: string, pinnedDirectory: string): string[] {
  const record = readRecord<CollaboratorsFile>(pinnedDirectory, COLLABORATORS_FILE);
  if (typeof record === 'string') return [record];
  const recorded = record.collaborators ?? {};
  const actual = applicationCollaborators(baseDir);
  const file = `${PINNED_DIRECTORY}/${COLLABORATORS_FILE}`;
  const problems: string[] = [];
  for (const path of actual.filter((p) => !(p in recorded))) {
    problems.push(
      `${path} is a file directly in application/, which is not recorded. Shared application logic ` +
        'is the last resort (backend.md §3 rule 3): first move it onto the domain object it is ' +
        'about, put an infrastructure capability behind a port, merge features that share most ' +
        'steps, request a later step as a job or event, or repeat the small remainder. If none of ' +
        `these applies, record the file in ${file} with a "reason" saying which of those steps you ` +
        'tried and why it did not apply.',
    );
  }
  for (const path of Object.keys(recorded).filter((p) => !actual.includes(p))) {
    problems.push(
      `${path} is recorded as an application collaborator but the file no longer exists. Remove it from ${file}.`,
    );
  }
  for (const [path, entry] of Object.entries(recorded)) {
    if (!hasReason(entry)) {
      problems.push(
        `${path} has no "reason" in ${file}: name the step of rule 3 that was tried and why it did not apply.`,
      );
    }
  }
  return problems;
}

function aggregateRootProblems(baseDir: string, pinnedDirectory: string): string[] {
  const record = readRecord<AggregateRootsFile>(pinnedDirectory, ROOTS_FILE);
  if (typeof record === 'string') return [record];
  const recorded = record.roots ?? {};
  const actual = aggregateRoots(baseDir);
  const file = `${PINNED_DIRECTORY}/${ROOTS_FILE}`;
  const how =
    `Update ${file} in this pull request. A root has its own id that others refer to, its own ` +
    'repository and its own transaction (backend.md §3 rule 11); give it a one-line reason. A ' +
    'child entity, which has an identity only within its root, is pinned as a child in ' +
    'tests/architecture/api/aggregate-rules.ts instead, and when unsure the two are separate roots.';
  const problems: string[] = [];
  for (const name of Object.keys(actual)
    .filter((n) => !(n in recorded))
    .sort()) {
    problems.push(
      `${name} (${actual[name]}) is an entity file whose class is not recorded as an aggregate root. ${how}`,
    );
  }
  for (const name of Object.keys(recorded)
    .filter((n) => !(n in actual))
    .sort()) {
    problems.push(
      `${name} is recorded as an aggregate root but no such entity class exists any more (removed, renamed, or now a pinned child). ${how}`,
    );
  }
  for (const [name, entry] of Object.entries(recorded)) {
    if (!hasReason(entry)) {
      problems.push(
        `${name} has no "reason" in ${file}: say in one line why it is an aggregate root.`,
      );
    }
  }
  return problems;
}
