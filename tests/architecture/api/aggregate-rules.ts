import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { listDirectories, listFiles, type Violation } from '../harness';
import { isErrorClass, moduleImports, target } from './layout-rules';

/**
 * The four checks that follow from rules 10 to 12 of backend.md §3 (Issue #182): aggregate
 * roots in `domain/entities/`, one repository per root, and handlers that return plain data.
 * Syntax and file tree only, as in `layout-rules.ts`: each file is parsed on its own, without
 * type checking, so the checks work on fixtures.
 */
export const AGGREGATE_RULES = [
  'api-entry-points-no-entity-classes',
  'api-handlers-return-plain-data',
  'api-repository-refers-to-one-entity',
  'api-entities-do-not-import-entities',
];

/**
 * Modules the four checks apply to. Issue #182 introduces them for `projects`, #183 adds
 * `executions`, and #170 removes the list so every module is checked by path pattern. A listed
 * module is checked once it has a `domain/entities/` directory, which is where its aggregate
 * roots are; a module without one has no root to refer to.
 */
const AGGREGATE_MODULES = new Set(['projects', 'executions']);

/**
 * Child entities of an aggregate, by the file of their root: a child entity has its identity only
 * within its root and is created and bounded through it, so the root's file and its repository
 * may refer to it. Pinned here: a new child entity is a modelling decision.
 */
const CHILD_ENTITIES: Record<string, string[]> = {
  'src/modules/executions/domain/entities/run.ts': [
    'src/modules/executions/domain/entities/run-step.ts',
  ],
};

const ENTITY_FILE = /^src\/modules\/([^/]+)\/domain\/entities\/[^/]+\.ts$/;
const HANDLER_FILE = /^src\/modules\/([^/]+)\/application\/features\/[^/]+\/handler\.ts$/;
const REPOSITORY_FILE = /^src\/modules\/([^/]+)\/domain\/repositories\/[^/]+\.ts$/;
const ENTRY_POINT_FILE = /^src\/modules\/([^/]+)\/entry-points\//;
const VALUE_OBJECT_FILE = /^src\/modules\/([^/]+)\/domain\/value-objects\//;
/** An id type, the one thing an entity file may take from another entity file. */
const ID_TYPE_NAME = /Id$/;
const HANDLER_SUFFIX = /Handler$/;

export function aggregateViolations(baseDir: string): Violation[] {
  const modules = listDirectories(baseDir, 'src/modules').filter(
    (module) =>
      AGGREGATE_MODULES.has(module) &&
      listDirectories(baseDir, `src/modules/${module}/domain`).includes('entities'),
  );
  return modules.flatMap((module) => {
    const files = listFiles(baseDir, `src/modules/${module}`).filter(
      (path) => path.endsWith('.ts') && !path.endsWith('.d.ts'),
    );
    const entityClasses = entityClassNames(baseDir, files);
    return [
      ...files
        .filter((path) => ENTRY_POINT_FILE.test(path))
        .flatMap((path) => entryPointViolations(baseDir, path, entityClasses)),
      ...files
        .filter((path) => HANDLER_FILE.test(path))
        .flatMap((path) => handlerViolations(baseDir, path, entityClasses)),
      ...files
        .filter((path) => REPOSITORY_FILE.test(path))
        .flatMap((path) => repositoryViolations(baseDir, path)),
      ...files
        .filter((path) => ENTITY_FILE.test(path))
        .flatMap((path) => entityImportViolations(baseDir, path)),
    ];
  });
}

function parse(baseDir: string, path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(baseDir, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function isExported(declaration: ts.Node): boolean {
  return (
    ts.canHaveModifiers(declaration) &&
    (ts.getModifiers(declaration) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/** Names exported by a later `export { A, B }` statement without a module specifier. */
function exportedLater(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text);
      }
    }
  }
  return names;
}

/** Classes an entity file exports, not counting error classes: the aggregate's own classes. */
function exportedEntityClasses(source: ts.SourceFile): string[] {
  const later = exportedLater(source);
  return source.statements
    .filter(ts.isClassDeclaration)
    .filter(
      (declaration) =>
        declaration.name !== undefined &&
        (isExported(declaration) || later.has(declaration.name.text)) &&
        !isErrorClass(declaration),
    )
    .map((declaration) => declaration.name!.text);
}

/** The entity classes of each entity file of the module, by file path. */
function entityClassNames(baseDir: string, files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of files.filter((file) => ENTITY_FILE.test(file))) {
    found.set(path, exportedEntityClasses(parse(baseDir, path)));
  }
  return found;
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

/** The names of the types a type node refers to, through unions, arrays and type arguments. */
function referencedTypeNames(node: ts.TypeNode): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isTypeReferenceNode(current)) {
      names.push(current.typeName.getText());
    }
    current.forEachChild(visit);
  };
  visit(node);
  return names;
}

/**
 * Like {@link referencedTypeNames}, and also the names inside the interfaces and type aliases
 * the file declares itself, so a result type that wraps an entity class is seen through.
 */
function referencedTypeNamesDeep(node: ts.TypeNode, source: ts.SourceFile): string[] {
  const local = new Map<string, ts.Node>();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement)) local.set(statement.name.text, statement.type);
    else if (ts.isInterfaceDeclaration(statement)) local.set(statement.name.text, statement);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isTypeReferenceNode(current)) {
      const name = current.typeName.getText();
      names.push(name);
      const declared = local.get(name);
      if (declared && !seen.has(name)) {
        seen.add(name);
        visit(declared);
      }
    }
    current.forEachChild(visit);
  };
  visit(node);
  return names;
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
      (isExported(statement) || later.has(statement.name.text))
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
 * A handler (rule 10) has an `execute` that takes at most one input object and declares its
 * return type. The file exports the input type (`<Name>Input`, when `execute` takes input)
 * and the result type (`<Name>Result`, when it returns something) for the class
 * `<Name>Handler`, and `execute` uses them. No public method of a handler returns an entity
 * class of its module, so a result holds plain data (snapshots, ids, values, view types).
 */
function handlerViolations(
  baseDir: string,
  path: string,
  entityClasses: Map<string, string[]>,
): Violation[] {
  const source = parse(baseDir, path);
  const exported = exportedDeclarations(source);
  const entityNames = new Set([...entityClasses.values()].flat());
  const handlers = source.statements
    .filter(ts.isClassDeclaration)
    .filter(
      (declaration) =>
        declaration.name !== undefined &&
        HANDLER_SUFFIX.test(declaration.name.text) &&
        (isExported(declaration) || exportedLater(source).has(declaration.name.text)),
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
      const returned = method.type ? referencedTypeNamesDeep(method.type, source) : [];
      for (const name of returned.filter((returnedName) => entityNames.has(returnedName))) {
        found.push(violation(`${method.name.getText()} returns the entity class ${name}`));
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
    if (!execute.type) {
      found.push(violation('execute does not declare its return type'));
      return found;
    }
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

/** What a file imports by local name: `local name → module specifier`. */
function importedNames(source: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        names.set(element.name.text, statement.moduleSpecifier.text);
      }
    }
  }
  return names;
}

/**
 * A repository interface serves one aggregate root (rule 11): the file refers to exactly one
 * file in `domain/entities/`, and no method returns a type taken from `domain/value-objects/`
 * (a record of a root with no behaviour is a value object, never the thing a store returns).
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
  const imported = importedNames(source);
  for (const statement of source.statements.filter(ts.isInterfaceDeclaration)) {
    for (const member of statement.members.filter(ts.isMethodSignature)) {
      if (!member.type) continue;
      for (const name of referencedTypeNames(member.type)) {
        const specifier = imported.get(name);
        const to = specifier ? target(path, specifier) : undefined;
        if (to && VALUE_OBJECT_FILE.test(to)) {
          found.push(violation(`${member.name.getText()} returns ${name} from ${to}`));
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
