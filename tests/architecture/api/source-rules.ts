import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { listFiles, type Violation } from '../harness';

/**
 * Source-level rules of `architecture:api` that Dependency Cruiser cannot express, because
 * they depend on declaration names and kinds rather than on import edges
 * (docs/architecture/backend.md §4 and §6). Syntax only: each file is parsed on its own,
 * without type checking, so the rules work on fixtures whose npm imports do not resolve.
 */
export const SOURCE_RULES = [
  'api-event-versioned',
  'api-event-publisher-owned',
  'api-event-no-duplicates',
  'api-repository-contract-placement',
  'api-adapter-contract-placement',
];

export function sourceViolations(baseDir: string): Violation[] {
  const files = sourceFiles(baseDir).map((path) => ({ path, source: parse(baseDir, path) }));
  return [
    ...eventViolations(baseDir, files),
    ...repositoryContractViolations(files),
    ...adapterContractViolations(baseDir, files),
  ];
}

interface SourceFile {
  /** POSIX path relative to the gate's base directory. */
  path: string;
  source: ts.SourceFile;
}

const EVENTS_DIR = /^src\/modules\/[^/]+\/contracts\/events\//;
/** `src/modules/<publisher>/contracts/events/<event-name>-v<n>.ts`, directly in events/. */
const EVENT_FILE =
  /^src\/modules\/([^/]+)\/contracts\/events\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-v([1-9][0-9]*)\.ts$/;
/** An event definition name: `<EventName>V<n>` or `<EventName>V<n>Schema`. */
const EVENT_NAME = /^([A-Z][A-Za-z0-9]*?)V[1-9][0-9]*(Schema)?$/;
/** A module's contracts/ outside events/ and the within-module HTTP/SSE DTOs of http/. */
const CONTRACTS_OUTSIDE_EVENTS = /^src\/modules\/[^/]+\/contracts\/(?!events\/|http\/)/;
/** The public entry point of a module's contracts: `src/modules/<module>/contracts/index.ts`. */
const CONTRACTS_INDEX = /^src\/modules\/([^/]+)\/contracts\/index\.ts$/;
const MODULE_CONTRACTS = /^src\/modules\/([^/]+)\/contracts\//;
/** An event-like name (`ExecutionCompletedEvent`, `ExecutionCompletedEventSchema`). */
const EVENT_LIKE_NAME = /Event(Schema)?$/;

/**
 * Integration events (backend.md §6): each version of an event is defined once, by its
 * publisher, in `contracts/events/<event-name>-v<n>.ts`, which exports only
 * `<EventName>V<n>` and/or `<EventName>V<n>Schema`, declared in that file. An event-like
 * declaration elsewhere in `contracts/` (except `contracts/http/`), a competing definition of
 * a published event anywhere else, a published event exposed under another name or by
 * any file but its publisher's `contracts/index.ts`, and the same event in two modules are
 * rejected.
 */
function eventViolations(baseDir: string, files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  const publishers = new Map<string, Set<string>>();

  for (const { path, source } of files.filter((file) => EVENTS_DIR.test(file.path))) {
    const match = EVENT_FILE.exec(path);
    if (!match) {
      violations.push({ rule: 'api-event-versioned', from: path });
      continue;
    }
    const [, module, fileName, version] = match;
    const event = pascalCase(fileName!);
    publishers.set(event, (publishers.get(event) ?? new Set()).add(module!));

    const exported = exportedNames(source);
    if (exported.length === 0) {
      violations.push({ rule: 'api-event-versioned', from: path });
    }
    const allowed = [`${event}V${version}`, `${event}V${version}Schema`];
    for (const { name, local } of exported) {
      if (!allowed.includes(name)) {
        violations.push({ rule: 'api-event-versioned', from: path, to: name });
      }
      if (!local) {
        violations.push({ rule: 'api-event-publisher-owned', from: path, to: name });
      }
    }
  }

  for (const { path, source } of files.filter((file) => !EVENTS_DIR.test(file.path))) {
    if (CONTRACTS_OUTSIDE_EVENTS.test(path)) {
      for (const name of declaredNames(source).filter((name) => EVENT_LIKE_NAME.test(name))) {
        violations.push({ rule: 'api-event-versioned', from: path, to: name });
      }
    }
    for (const name of allDeclaredNames(source)) {
      const event = EVENT_NAME.exec(name)?.[1];
      if (event && publishers.has(event)) {
        violations.push({ rule: 'api-event-publisher-owned', from: path, to: name });
      }
    }
    violations.push(...eventExposureViolations(baseDir, path, source, publishers));
  }

  for (const [event, modules] of publishers) {
    if (modules.size > 1) {
      violations.push({
        rule: 'api-event-no-duplicates',
        from: event,
        to: [...modules].sort().join(', '),
      });
    }
  }
  return violations;
}

/**
 * A published event leaves its publisher only under its own name and only through the
 * publisher's `contracts/index.ts`: no renaming re-export (`export { XV1 as Y }`), no alias
 * declaration (`type Y = XV1`, `const Y = XV1Schema`), and no re-export (named or `export *`)
 * by any other file, e.g. another module's `contracts/index.ts` or a consumer.
 */
function eventExposureViolations(
  baseDir: string,
  path: string,
  source: ts.SourceFile,
  publishers: Map<string, Set<string>>,
): Violation[] {
  const violations: Violation[] = [];
  const fail = (name: string) =>
    violations.push({ rule: 'api-event-publisher-owned', from: path, to: name });
  const imports = importBindings(source);
  const original = (local: string) => imports.get(local)?.imported ?? local;
  const ownIndexOf = CONTRACTS_INDEX.exec(path)?.[1];
  const publisherOf = (name: string): Set<string> | undefined => {
    const event = EVENT_NAME.exec(name)?.[1];
    return event ? publishers.get(event) : undefined;
  };
  const publishingModules = new Set([...publishers.values()].flatMap((modules) => [...modules]));

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        // `export * [as ns] from` another module's contracts, or from an event file anywhere
        // but the publisher's own index, re-exports events without naming them.
        const target = specifier ? resolveRelative(baseDir, path, specifier) : undefined;
        const targetModule = target ? MODULE_CONTRACTS.exec(target)?.[1] : undefined;
        const renames = clause !== undefined && EVENTS_DIR.test(target ?? '');
        if (
          targetModule &&
          publishingModules.has(targetModule) &&
          (targetModule !== ownIndexOf || renames)
        ) {
          fail(clause ? clause.name.text : '*');
        }
        continue;
      }
      for (const element of clause.elements) {
        const exported = (element.propertyName ?? element.name).text;
        const name = specifier ? exported : original(exported);
        const modules = publisherOf(name);
        if (!modules) continue;
        if (element.name.text !== name || !ownIndexOf || !modules.has(ownIndexOf)) {
          fail(element.name.text);
        }
      }
    } else if (
      ts.isTypeAliasDeclaration(statement) &&
      ts.isTypeReferenceNode(statement.type) &&
      ts.isIdentifier(statement.type.typeName) &&
      publisherOf(original(statement.type.typeName.text))
    ) {
      fail(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          initializer &&
          ts.isIdentifier(initializer) &&
          ts.isIdentifier(declaration.name) &&
          publisherOf(original(initializer.text))
        ) {
          fail(declaration.name.text);
        }
      }
    }
  }
  return violations;
}

const DOMAIN_REPOSITORIES = /^src\/modules\/[^/]+\/domain\/repositories\//;
const PORTS = /^src\/modules\/[^/]+\/ports\//;
const BUSINESS_MODULES = /^src\/modules\//;

/**
 * Contract names (backend.md §4), inside business modules: an interface, type alias or abstract class named
 * `…ReadRepository` or `…Reader` is a read port and lives in `ports/`; any other
 * `…Repository` contract is an aggregate repository and lives in `domain/repositories/`.
 * Concrete classes (`PrismaProjectRepository`) are implementations, not contracts.
 */
function repositoryContractViolations(files: SourceFile[]): Violation[] {
  const moduleFiles = files.filter((file) => BUSINESS_MODULES.test(file.path));
  return moduleFiles.flatMap(({ path, source }) =>
    contractDeclarations(source)
      .map((declaration) => declaration.name!.text)
      .filter((name) => {
        if (/(ReadRepository|Reader)$/.test(name)) return !PORTS.test(path);
        if (/Repository$/.test(name)) return !DOMAIN_REPOSITORIES.test(path);
        return false;
      })
      .map((name) => ({ rule: 'api-repository-contract-placement', from: path, to: name })),
  );
}

const INFRASTRUCTURE = /^src\/modules\/[^/]+\/infrastructure\//;

/**
 * Every contract an infrastructure adapter implements (`implements X`, or `extends X` for an
 * abstract class X) that is declared in a business module is declared in
 * `domain/repositories/` or `ports/`, so no service interface hides in `features/`,
 * `domain/entities/` or the adapter itself. Contracts from npm packages
 * (`OnModuleInit`) or from `platform/` are not business-module contracts.
 */
function adapterContractViolations(baseDir: string, files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const { path, source } of files.filter((file) => INFRASTRUCTURE.test(file.path))) {
    const imports = importBindings(source);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      for (const clause of statement.heritageClauses ?? []) {
        const implementsClause = clause.token === ts.SyntaxKind.ImplementsKeyword;
        for (const { expression } of clause.types) {
          const target = locate(baseDir, path, source, imports, expression);
          if (!target || (!implementsClause && !target.abstractClass)) continue;
          const allowed = DOMAIN_REPOSITORIES.test(target.path) || PORTS.test(target.path);
          if (BUSINESS_MODULES.test(target.path) && !allowed) {
            violations.push({
              rule: 'api-adapter-contract-placement',
              from: path,
              to: `${target.path} ${target.name}`,
            });
          }
        }
      }
    }
  }
  return violations;
}

interface ImportBinding {
  specifier: string;
  /** The exported name, or `*` for a namespace import. */
  imported: string;
}

function importBindings(source: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const { name, namedBindings } = statement.importClause;
    if (name) bindings.set(name.text, { specifier, imported: 'default' });
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.set(namedBindings.name.text, { specifier, imported: '*' });
    } else if (namedBindings) {
      for (const element of namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        bindings.set(element.name.text, { specifier, imported });
      }
    }
  }
  return bindings;
}

/** Where the class or interface a heritage clause names is declared, if it is local code. */
function locate(
  baseDir: string,
  path: string,
  source: ts.SourceFile,
  imports: Map<string, ImportBinding>,
  expression: ts.Expression,
): { path: string; name: string; abstractClass: boolean } | undefined {
  let binding: ImportBinding | undefined;
  let name: string;
  if (ts.isIdentifier(expression)) {
    name = expression.text;
    binding = imports.get(name);
    if (!binding) {
      return isDeclaredIn(source, name)
        ? { path, name, abstractClass: isAbstractClassIn(source, name) }
        : undefined;
    }
    name = binding.imported;
  } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    binding = imports.get(expression.expression.text);
    if (binding?.imported !== '*') return undefined;
    name = expression.name.text;
  } else {
    return undefined;
  }

  const target = resolveRelative(baseDir, path, binding.specifier);
  return target ? declarationOf(baseDir, target, name) : undefined;
}

/**
 * Follows re-exports (`export { X } from`, `export *`, `import { X }` + `export { X }`) and
 * re-badging declarations (`type Y = X`, `interface Y extends X {}`) from `path` to the file
 * that declares the contract, so a barrel or alias in `ports/` cannot pass off a contract
 * declared in `features/` or `domain/services/`. If none is found, `path` itself is reported.
 */
function declarationOf(
  baseDir: string,
  path: string,
  name: string,
  seen = new Set<string>(),
): { path: string; name: string; abstractClass: boolean } {
  const source = parse(baseDir, path);
  const here = { path, name, abstractClass: isAbstractClassIn(source, name) };
  if (seen.has(`${path}#${name}`)) return here;
  seen.add(`${path}#${name}`);
  const imports = importBindings(source);
  if (isDeclaredIn(source, name)) {
    const aliased = aliasTarget(source, name);
    if (!aliased) return here;
    const binding = imports.get(aliased);
    const target = binding ? resolveRelative(baseDir, path, binding.specifier) : path;
    if (!target) return here;
    return declarationOf(baseDir, target, binding ? binding.imported : aliased, seen);
  }
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    let next: { specifier: string; name: string } | undefined;
    if (!statement.exportClause && specifier) {
      next = { specifier, name };
    } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const element = statement.exportClause.elements.find((e) => e.name.text === name);
      const local = element && (element.propertyName ?? element.name).text;
      const binding = local ? imports.get(local) : undefined;
      if (local && specifier) next = { specifier, name: local };
      else if (binding) next = { specifier: binding.specifier, name: binding.imported };
    }
    const target = next && resolveRelative(baseDir, path, next.specifier);
    if (!next || !target) continue;
    const found = declarationOf(baseDir, target, next.name, seen);
    if (isDeclaredIn(parse(baseDir, found.path), found.name)) return found;
  }
  return here;
}

/** The `X` of `type name = X` or `interface name extends X {}`, if `name` only re-badges X. */
function aliasTarget(source: ts.SourceFile, name: string): string | undefined {
  for (const statement of source.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === name &&
      ts.isTypeReferenceNode(statement.type) &&
      ts.isIdentifier(statement.type.typeName)
    ) {
      return statement.type.typeName.text;
    }
    if (
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === name &&
      statement.members.length === 0 &&
      statement.heritageClauses?.length === 1 &&
      statement.heritageClauses[0]!.types.length === 1
    ) {
      const expression = statement.heritageClauses[0]!.types[0]!.expression;
      if (ts.isIdentifier(expression)) return expression.text;
    }
  }
  return undefined;
}

/** Resolves a relative import (`./x.js` → `x.ts`) to a POSIX path; npm imports give undefined. */
function resolveRelative(baseDir: string, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = joined.replace(/\.(js|ts)x?$/, '');
  return [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find((candidate) =>
    existsSync(join(baseDir, candidate)),
  );
}

type NamedDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration;

/** Interfaces, type aliases and abstract classes declared at the top level. */
function contractDeclarations(source: ts.SourceFile): NamedDeclaration[] {
  return source.statements.filter(
    (statement): statement is NamedDeclaration =>
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        (ts.isClassDeclaration(statement) &&
          hasModifier(statement, ts.SyntaxKind.AbstractKeyword))) &&
      statement.name !== undefined,
  );
}

/** Names of all top-level declarations (not imports), exported or not. */
function declaredNames(source: ts.SourceFile): string[] {
  return source.statements.flatMap(statementNames);
}

function statementNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (
    (ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name &&
    ts.isIdentifier(statement.name)
  ) {
    return [statement.name.text];
  }
  return [];
}

/** Names of all declarations at any depth, e.g. a payload type redefined inside a function. */
function allDeclaredNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isDeclaredIn(source: ts.SourceFile, name: string): boolean {
  return declaredNames(source).includes(name);
}

function isAbstractClassIn(source: ts.SourceFile, name: string): boolean {
  return source.statements.some(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === name &&
      hasModifier(statement, ts.SyntaxKind.AbstractKeyword),
  );
}

/**
 * Every name a file exports, and whether it is defined in the file itself (`local`).
 * `export *` and `export default` are reported as `*` and `default`, never valid event names.
 */
function exportedNames(source: ts.SourceFile): { name: string; local: boolean }[] {
  const declared = new Set(declaredNames(source));
  return source.statements.flatMap((statement): { name: string; local: boolean }[] => {
    if (ts.isExportDeclaration(statement)) {
      const reexport = statement.moduleSpecifier !== undefined;
      if (!statement.exportClause) return [{ name: '*', local: false }];
      if (ts.isNamespaceExport(statement.exportClause)) {
        return [{ name: statement.exportClause.name.text, local: false }];
      }
      return statement.exportClause.elements.map((element) => ({
        name: element.name.text,
        local: !reexport && declared.has((element.propertyName ?? element.name).text),
      }));
    }
    if (ts.isExportAssignment(statement)) return [{ name: 'default', local: true }];
    if (ts.isImportEqualsDeclaration(statement)) {
      return hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        ? [{ name: statement.name.text, local: false }]
        : [];
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return [];
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      return [{ name: 'default', local: true }];
    }
    return statementNames(statement).map((name) => ({ name, local: true }));
  });
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

/** `execution-completed` → `ExecutionCompleted`. */
function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Production TypeScript under `src/` (tests and declaration files excluded). */
function sourceFiles(baseDir: string): string[] {
  return listFiles(baseDir, 'src').filter(
    (path) =>
      /\.tsx?$/.test(path) &&
      !path.endsWith('.d.ts') &&
      !/(^|\/)__tests__\//.test(path) &&
      !/\.(test|spec)\.tsx?$/.test(path),
  );
}

function parse(baseDir: string, path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(baseDir, path), 'utf8'),
    ts.ScriptTarget.Latest,
  );
}
