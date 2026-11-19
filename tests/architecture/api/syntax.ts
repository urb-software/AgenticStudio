import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

/**
 * Syntax helpers shared by the structure checks of `architecture:api`. Syntax only: each file is
 * parsed on its own, without type checking, so the checks work on fixtures whose npm imports do
 * not resolve.
 */

export function parse(baseDir: string, path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(baseDir, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

export interface ModuleImport {
  /** The module specifier, e.g. `../ports/clock.js`. */
  specifier: string;
  /**
   * Imported names; `*` for a namespace import and for anything whose names cannot be listed (a
   * side-effect import, a dynamic `import()`, an `import x = require()`, `export *`), `default`
   * for a default import.
   */
  names: string[];
}

/**
 * Every way a file reaches another module (type-only ones included): `import … from`,
 * `export … from`, side-effect imports (`import './x.js'`), `import x = require('./x.js')`,
 * dynamic `import('./x.js')` and import types (`type T = import('./x.js').T`), at any depth.
 */
export function moduleImports(baseDir: string, path: string): ModuleImport[] {
  const source = parse(baseDir, path);
  const found: ModuleImport[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      if (!clause) names.push('*');
      else {
        const { name, namedBindings } = clause;
        if (name) names.push('default');
        if (namedBindings && ts.isNamespaceImport(namedBindings)) names.push('*');
        else if (namedBindings) {
          names.push(
            ...namedBindings.elements.map((element) => (element.propertyName ?? element.name).text),
          );
        }
      }
      found.push({ specifier: node.moduleSpecifier.text, names });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const names =
        clause && ts.isNamedExports(clause)
          ? clause.elements.map((element) => (element.propertyName ?? element.name).text)
          : ['*'];
      found.push({ specifier: node.moduleSpecifier.text, names });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push({ specifier: node.moduleReference.expression.text, names: ['*'] });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, names: ['*'] });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const qualifier = node.qualifier ? leftmost(node.qualifier).text : '*';
      found.push({ specifier: node.argument.literal.text, names: [qualifier] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function leftmost(name: ts.EntityName): ts.Identifier {
  return ts.isQualifiedName(name) ? leftmost(name.left) : name;
}

/** A relative specifier as a POSIX `.ts` path below the base directory (the file may not exist). */
export function target(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  return `${joined.replace(/\.(js|ts)x?$/, '')}.ts`;
}

export function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Names exported by a later `export { A, B }` statement without a module specifier. */
export function exportedLater(source: ts.SourceFile): Set<string> {
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

/** Strips parentheses, `as`, `satisfies`, `<T>x` and `x!`: they change the type, not the value. */
export function unwrapExpression(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/** A class a file exports, as a declaration or as `export const Name = class {}`. */
export interface ExportedClass {
  name: string;
  node: ts.ClassLikeDeclaration;
}

export function exportedClasses(source: ts.SourceFile): ExportedClass[] {
  const later = exportedLater(source);
  const found: ExportedClass[] = [];
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement)) {
      if (hasExportModifier(statement) || (statement.name && later.has(statement.name.text))) {
        found.push({ name: statement.name?.text ?? 'default', node: statement });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = unwrapExpression(declaration.initializer);
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isClassExpression(initializer) &&
          (hasExportModifier(statement) || later.has(declaration.name.text))
        ) {
          found.push({ name: declaration.name.text, node: initializer });
        }
      }
    }
  }
  return found;
}

const ERROR_NAME = /Error$/;

/** A class named `…Error` or extending `Error`: a domain error, not an entity. */
export function isErrorClass(exported: ExportedClass): boolean {
  if (ERROR_NAME.test(exported.name)) return true;
  return (exported.node.heritageClauses ?? []).some(
    (clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword &&
      clause.types.some(
        (type) => ts.isIdentifier(type.expression) && type.expression.text === 'Error',
      ),
  );
}

/** The names a file exports: declarations, variables, `export { A, B as C }`, re-exports. */
export function exportedNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map((element) => element.name.text));
      } else if (statement.exportClause) names.push(statement.exportClause.name.text);
    } else if (hasExportModifier(statement)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      } else if (
        (ts.isClassDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      ) {
        names.push(statement.name.text);
      }
    }
  }
  return names;
}

/** `interface X {}` or `type X = {}`: its name and members; undefined for any other statement. */
export function repositoryContract(
  statement: ts.Statement,
): { name: string; members: readonly ts.TypeElement[] } | undefined {
  if (ts.isInterfaceDeclaration(statement)) {
    return { name: statement.name.text, members: statement.members };
  }
  if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
    return { name: statement.name.text, members: statement.type.members };
  }
  return undefined;
}

const COMPANION_SUFFIX = 'data|facts';

/** A type-only companion of an entity, recognised by its file suffix alone. */
export const COMPANION_FILE = new RegExp(
  `^src/modules/([^/]+)/domain/entities/[^/]+-(?:${COMPANION_SUFFIX})\\.ts$`,
);

/** An entity file: a file of `domain/entities/` that is not a companion. */
export const ENTITY_FILE = new RegExp(
  `^src/modules/([^/]+)/domain/entities/(?![^/]*-(?:${COMPANION_SUFFIX})\\.ts$)[^/]+\\.ts$`,
);

/**
 * What a file exports that exists at run time: classes, functions, variables, enums, namespaces,
 * a default export, `export *` and a re-export of a name that is not a type. An interface, a type
 * alias and `export type { … }` are not. An empty result means the file exports types only.
 */
export function runtimeExports(source: ts.SourceFile): string[] {
  const typeNames = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      typeNames.add(statement.name.text);
    } else if (
      ts.isImportDeclaration(statement) &&
      statement.importClause &&
      statement.importClause.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        if (statement.importClause.isTypeOnly || element.isTypeOnly)
          typeNames.add(element.name.text);
      }
    }
  }
  const found: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        found.push('*');
        continue;
      }
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        const isType = element.isTypeOnly || (!statement.moduleSpecifier && typeNames.has(local));
        if (!isType) found.push(element.name.text);
      }
    } else if (ts.isExportAssignment(statement)) {
      found.push('default');
    } else if (hasExportModifier(statement)) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          found.push(declaration.name.getText());
        }
      } else if (
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
      ) {
        found.push(statement.name?.getText() ?? 'default');
      }
    }
  }
  return found;
}
