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

/** Strips parentheses, `as`, `satisfies`, `<T>x` and `x!`, which change the type and not the value. */
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
