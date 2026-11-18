import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { listDirectories, listFiles, type Violation } from '../harness';
import {
  exportedClasses,
  exportedLater,
  hasExportModifier,
  isErrorClass,
  COMPANION_FILE,
  ENTITY_FILE,
  moduleImports,
  parse,
  repositoryContract,
  target,
} from './syntax';

/** Syntax-only checks for rules 10 to 12 of backend.md §3 (aggregates, repositories, handlers). */
export const AGGREGATE_RULES = [
  'api-entry-points-no-entity-classes',
  'api-handlers-return-plain-data',
  'api-handler-input-plain-data',
  'api-repository-refers-to-one-entity',
  'api-entities-do-not-import-entities',
];

/**
 * Child entities of an aggregate, by the file of their root: a child entity has its identity only
 * within its root and is created and bounded through it, so the root's file and its repository
 * may refer to it. Pinned here: a new child entity is a modelling decision.
 */
export const CHILD_ENTITIES: Record<string, string[]> = {
  'src/modules/executions/domain/entities/run.ts': [
    'src/modules/executions/domain/entities/run-step.ts',
  ],
};

const HANDLER_FILE = /^src\/modules\/([^/]+)\/application\/features\/[^/]+\/handler\.ts$/;
const REPOSITORY_FILE = /^src\/modules\/([^/]+)\/domain\/repositories\/[^/]+\.ts$/;
const ENTRY_POINT_FILE = /^src\/modules\/([^/]+)\/entry-points\//;
const DOMAIN_CLASS_FILE = /^src\/modules\/([^/]+)\/domain\/(entities|value-objects)\/(?!.*__tests__\/)[^/]+\.ts$/;
const VALUE_OBJECT_FILE = /^src\/modules\/([^/]+)\/domain\/value-objects\//;
/** An id type, the one thing an entity file may take from another entity file. */
const ID_TYPE_NAME = /Id$/;
const HANDLER_SUFFIX = /Handler$/;

export function aggregateViolations(baseDir: string): Violation[] {
  return listDirectories(baseDir, 'src/modules').flatMap((module) => {
    const files = listFiles(baseDir, `src/modules/${module}`).filter(
      (path) => path.endsWith('.ts') && !path.endsWith('.d.ts'),
    );
    const entityClasses = entityClassNames(baseDir, files);
    const domainClasses = domainClassNames(baseDir, files);
    return [
      ...files
        .filter((path) => ENTRY_POINT_FILE.test(path))
        .flatMap((path) => entryPointViolations(baseDir, path, entityClasses)),
      ...files
        .filter((path) => HANDLER_FILE.test(path))
        .flatMap((path) => handlerViolations(baseDir, path, entityClasses)),
      ...files
        .filter((path) => HANDLER_FILE.test(path))
        .flatMap((path) => handlerInputViolations(baseDir, path, domainClasses)),
      ...files
        .filter((path) => REPOSITORY_FILE.test(path))
        .flatMap((path) => repositoryViolations(baseDir, path)),
      ...files
        .filter((path) => ENTITY_FILE.test(path))
        .flatMap((path) => entityImportViolations(baseDir, path)),
    ];
  });
}

/** Classes an entity file exports, not counting error classes: the aggregate's own classes. */
function exportedEntityClasses(source: ts.SourceFile): string[] {
  return exportedClasses(source)
    .filter((exported) => !isErrorClass(exported))
    .map((exported) => exported.name);
}

/** The entity classes of each entity file of the module, by file path. */
function entityClassNames(baseDir: string, files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of files.filter((file) => ENTITY_FILE.test(file))) {
    found.set(path, exportedEntityClasses(parse(baseDir, path)));
  }
  return found;
}

/** The classes of each file of `domain/entities/` and `domain/value-objects/`, errors excluded. */
function domainClassNames(baseDir: string, files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of files.filter((file) => DOMAIN_CLASS_FILE.test(file))) {
    found.set(path, exportedEntityClasses(parse(baseDir, path)));
  }
  return found;
}

/**
 * A handler's input holds plain data (rule 10): it refers to no class from `domain/`, an
 * interface it extends included. Plain types, lists of allowed values and the input's own nested
 * shapes are allowed.
 */
function handlerInputViolations(
  baseDir: string,
  path: string,
  domainClasses: Map<string, string[]>,
): Violation[] {
  const source = parse(baseDir, path);
  const imported = importedNames(source);
  const handler = source.statements
    .filter(ts.isClassDeclaration)
    .find((declaration) => declaration.name && HANDLER_SUFFIX.test(declaration.name.text));
  if (!handler?.name) return [];
  const inputName = `${handler.name.text.replace(HANDLER_SUFFIX, '')}Input`;
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === inputName,
  );
  if (!declaration) return [];
  const references: TypeReference[] = [];
  if (ts.isTypeAliasDeclaration(declaration)) {
    references.push(...typeReferencesDeep(declaration.type, source));
  } else {
    for (const member of declaration.members) {
      references.push(...typeReferencesDeep(member as unknown as ts.TypeNode, source));
    }
    for (const clause of declaration.heritageClauses ?? []) {
      for (const type of clause.types) {
        references.push(entityNameParts(type.expression as ts.EntityName));
      }
    }
  }
  return references
    .filter((reference) => {
      const to = referenceTarget(reference, path, imported);
      return to !== undefined && domainClasses.get(to)?.includes(reference.leaf) === true;
    })
    .map((reference) => ({
      rule: 'api-handler-input-plain-data',
      from: path,
      to: `${inputName} refers to the domain class ${reference.text}`,
    }));
}

/**
 * An entry point takes no class from `domain/entities/` (rule 10: an entity class never leaves
 * the application layer); types and errors are allowed. A namespace import of an entity file
 * that exports a class is refused too, since its members cannot be checked.
 */
function entryPointViolations(
  baseDir: string,
  path: string,
  entityClasses: Map<string, string[]>,
): Violation[] {
  return moduleImports(baseDir, path).flatMap((entry) => {
    const to = target(path, entry.specifier);
    const classes = to ? entityClasses.get(to) : undefined;
    if (!to || !classes) return [];
    return entry.names
      .filter((name) => (name === '*' ? classes.length > 0 : classes.includes(name)))
      .map((name) => ({
        rule: 'api-entry-points-no-entity-classes',
        from: path,
        to: `${to} ${name}`,
      }));
  });
}

/** A type a type node refers to: `Foo`, `ns.Foo` or `import('./x.js').Foo`. */
interface TypeReference {
  /** As written: `Foo`, `ns.Foo`, or the qualifier of an import type (`*` when it has none). */
  text: string;
  /** The first identifier: the local name the reference starts from. */
  root: string;
  /** The last identifier: the name of the type itself. */
  leaf: string;
  /** The module specifier of an import type. */
  specifier?: string;
}

function entityNameParts(name: ts.EntityName): { text: string; root: string; leaf: string } {
  const text = name.getText();
  const parts = text.split('.');
  return { text, root: parts[0]!, leaf: parts[parts.length - 1]! };
}

/** The types a type node refers to, through unions, arrays, type arguments and function types. */
function typeReferences(node: ts.TypeNode, local?: Map<string, ts.Node>): TypeReference[] {
  const found: TypeReference[] = [];
  const seen = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isTypeReferenceNode(current)) {
      const reference = entityNameParts(current.typeName);
      found.push(reference);
      const declared = reference.text === reference.root ? local?.get(reference.text) : undefined;
      if (declared && !seen.has(reference.text)) {
        seen.add(reference.text);
        visit(declared);
      }
    } else if (
      ts.isImportTypeNode(current) &&
      ts.isLiteralTypeNode(current.argument) &&
      ts.isStringLiteral(current.argument.literal)
    ) {
      const reference = current.qualifier
        ? entityNameParts(current.qualifier)
        : { text: '*', root: '*', leaf: '*' };
      found.push({ ...reference, specifier: current.argument.literal.text });
    }
    current.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** The names of the types a type node refers to, as written. */
function referencedTypeNames(node: ts.TypeNode): string[] {
  return typeReferences(node).map((reference) => reference.text);
}

/**
 * Like {@link typeReferences}, and also the references inside the interfaces and type aliases
 * the file declares itself, so a result type that wraps an entity class is seen through.
 */
function typeReferencesDeep(node: ts.TypeNode, source: ts.SourceFile): TypeReference[] {
  const local = new Map<string, ts.Node>();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) local.set(statement.name.text, statement.type);
    else if (ts.isInterfaceDeclaration(statement)) local.set(statement.name.text, statement);
  }
  return typeReferences(node, local);
}

/** `Promise<T>` → `T`; any other type is returned as it is. */
function unwrapPromise(node: ts.TypeNode): ts.TypeNode {
  if (
    ts.isTypeReferenceNode(node) &&
    node.typeName.getText() === 'Promise' &&
    node.typeArguments?.length === 1
  ) {
    return node.typeArguments[0]!;
  }
  return node;
}

function isNothing(node: ts.TypeNode): boolean {
  return [
    ts.SyntaxKind.VoidKeyword,
    ts.SyntaxKind.UndefinedKeyword,
    ts.SyntaxKind.NeverKeyword,
  ].includes(node.kind);
}

/** Names a file declares and exports: interfaces, type aliases, classes and enums. */
function exportedDeclarations(source: ts.SourceFile): Set<string> {
  const later = exportedLater(source);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name &&
      (hasExportModifier(statement) || later.has(statement.name.text))
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function isPublicMethod(member: ts.ClassElement): member is ts.MethodDeclaration {
  return (
    ts.isMethodDeclaration(member) &&
    !(ts.getModifiers(member) ?? []).some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    ) &&
    !member.name.getText().startsWith('#')
  );
}

/**
 * A handler's `execute` takes at most one input object and declares its return type; the file
 * exports `<Name>Input` and `<Name>Result` and no public method returns an entity class.
 */
function handlerViolations(
  baseDir: string,
  path: string,
  entityClasses: Map<string, string[]>,
): Violation[] {
  const source = parse(baseDir, path);
  const exported = exportedDeclarations(source);
  const imported = importedNames(source);
  const handlers = source.statements
    .filter(ts.isClassDeclaration)
    .filter(
      (declaration) =>
        declaration.name !== undefined &&
        HANDLER_SUFFIX.test(declaration.name.text) &&
        (hasExportModifier(declaration) || exportedLater(source).has(declaration.name.text)),
    );
  const violation = (to: string): Violation => ({
    rule: 'api-handlers-return-plain-data',
    from: path,
    to,
  });
  if (handlers.length === 0) return [violation('no exported <Name>Handler class')];
  return handlers.flatMap((handler) => {
    const base = handler.name!.text.replace(HANDLER_SUFFIX, '');
    const methods = handler.members.filter(isPublicMethod);
    const found: Violation[] = [];
    for (const method of methods) {
      const name = method.name.getText();
      const declared = methods.some((other) => other.name.getText() === name && other.type);
      if (!declared) found.push(violation(`${name} does not declare its return type`));
      for (const reference of method.type ? typeReferencesDeep(method.type, source) : []) {
        if (isEntityClass(reference, path, imported, entityClasses)) {
          found.push(violation(`${name} returns the entity class ${reference.text}`));
        }
      }
    }
    const execute = methods.find((method) => method.name.getText() === 'execute');
    if (!execute) return [...found, violation(`${handler.name!.text} has no execute method`)];
    if (execute.parameters.length > 1) {
      found.push(violation('execute takes more than one input object'));
    }
    const inputName = `${base}Input`;
    const [parameter] = execute.parameters;
    if (parameter) {
      const typed = parameter.type ? referencedTypeNames(parameter.type) : [];
      if (!exported.has(inputName)) found.push(violation(`${inputName} is not exported`));
      else if (!typed.includes(inputName))
        found.push(violation(`execute does not take ${inputName}`));
    }
    if (!execute.type) return found;
    const resultName = `${base}Result`;
    if (!isNothing(unwrapPromise(execute.type))) {
      if (!exported.has(resultName)) found.push(violation(`${resultName} is not exported`));
      else if (!referencedTypeNames(execute.type).includes(resultName)) {
        found.push(violation(`execute does not return ${resultName}`));
      }
    }
    return found;
  });
}

/** What a file imports by local name (named, default and namespace): `local name → specifier`. */
function importedNames(source: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause
    ) {
      continue;
    }
    const { name, namedBindings } = statement.importClause;
    if (name) names.set(name.text, statement.moduleSpecifier.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      names.set(namedBindings.name.text, statement.moduleSpecifier.text);
    } else if (namedBindings) {
      for (const element of namedBindings.elements) {
        names.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }
  return names;
}

/** The file a type reference comes from, when it is imported (named, qualified or import type). */
function referenceTarget(
  reference: TypeReference,
  path: string,
  imported: Map<string, string>,
): string | undefined {
  const specifier = reference.specifier ?? imported.get(reference.root);
  return specifier ? target(path, specifier) : undefined;
}

/**
 * Whether a reference names an entity class of the module: a plain name of one of its entity
 * classes, `ns.Entity` through a namespace import of an entity file, or an import type of one.
 */
function isEntityClass(
  reference: TypeReference,
  path: string,
  imported: Map<string, string>,
  entityClasses: Map<string, string[]>,
): boolean {
  if (reference.specifier !== undefined || reference.text !== reference.root) {
    const to = referenceTarget(reference, path, imported);
    return (to !== undefined && entityClasses.get(to)?.includes(reference.leaf)) === true;
  }
  return [...entityClasses.values()].some((classes) => classes.includes(reference.text));
}

/**
 * A repository interface serves one aggregate root (rule 11): the file refers to exactly one
 * file in `domain/entities/`, and no method returns a type taken from `domain/value-objects/`
 * or from a companion file other than its own entity's snapshot.
 */
function repositoryViolations(baseDir: string, path: string): Violation[] {
  const source = parse(baseDir, path);
  const violation = (to: string): Violation => ({
    rule: 'api-repository-refers-to-one-entity',
    from: path,
    to,
  });
  const referenced = moduleImports(baseDir, path)
    .map((entry) => target(path, entry.specifier))
    .filter((to): to is string => to !== undefined && ENTITY_FILE.test(to));
  const children = new Set(referenced.flatMap((to) => CHILD_ENTITIES[to] ?? []));
  // The child entities of a root are part of its aggregate: they do not count as another root.
  const entityFiles = new Set(referenced.filter((to) => !children.has(to)));
  const found: Violation[] = [];
  if (entityFiles.size !== 1) {
    found.push(violation(`refers to ${entityFiles.size} entity files, not exactly one`));
  }
  // The one value object a repository may return: the snapshot of the entity it serves (or of
  // that root's child entity), `entities/<entity>-snapshot.ts` in the same module.
  const ownSnapshots = new Set(
    [...referenced, ...children].map((entity) =>
      entity.replace(/\/entities\/([^/]+)\.ts$/, '/entities/$1-snapshot.ts'),
    ),
  );
  const imported = importedNames(source);
  for (const statement of source.statements) {
    for (const member of repositoryContract(statement)?.members ?? []) {
      // A method, or a property whose type is a function (`find: (id: string) => Promise<Run>`).
      const returned = ts.isMethodSignature(member)
        ? member.type
        : ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type)
          ? member.type.type
          : undefined;
      if (!returned) continue;
      for (const reference of typeReferences(returned)) {
        const to = referenceTarget(reference, path, imported);
        if (
          to &&
          (VALUE_OBJECT_FILE.test(to) || COMPANION_FILE.test(to)) &&
          !ownSnapshots.has(to)
        ) {
          found.push(
            violation(
              `${member.name?.getText() ?? 'a member'} returns ${reference.text} from ${to}`,
            ),
          );
        }
      }
    }
  }
  return found;
}

/** An entity file imports another entity file only for an id type (rule 12). */
function entityImportViolations(baseDir: string, path: string): Violation[] {
  return moduleImports(baseDir, path).flatMap((entry) => {
    const to = target(path, entry.specifier);
    if (!to || to === path || !ENTITY_FILE.test(to) || !existsSync(join(baseDir, to))) return [];
    // A root creates its own child entity: the one other thing an entity file may import.
    if ((CHILD_ENTITIES[path] ?? []).includes(to)) return [];
    return entry.names
      .filter((name) => !ID_TYPE_NAME.test(name))
      .map((name) => ({
        rule: 'api-entities-do-not-import-entities',
        from: path,
        to: `${to} ${name}`,
      }));
  });
}
