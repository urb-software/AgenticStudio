import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { listFiles, type Violation } from '../harness';

/**
 * The two checks that follow from rule 13 of backend.md §3, "one concept per file" (Issue
 * #185): an entity file exports exactly one class and no function, and `domain/` exports no
 * function other than a type guard. Syntax only, as in `layout-rules.ts`: each file is parsed
 * on its own, without type checking, so the checks work on fixtures. An entity file with no
 * class is already refused by `api-entities-are-classes-with-non-public-constructors`, so the
 * first check reports a second class and any function.
 */
export const FILE_RULES = [
  'api-entity-file-exports-one-class-and-no-function',
  'api-domain-exports-no-function-but-type-guards',
];

/**
 * Modules the two checks apply to. Issue #185 introduces them for `projects`, #184 adds
 * `executions`, and #170 removes the list so every module is checked by path pattern.
 */
const FILE_RULE_MODULES = new Set(['projects']);

const ENTITY_FILE = /^src\/modules\/([^/]+)\/domain\/entities\/[^/]+\.ts$/;
const DOMAIN_FILE = /^src\/modules\/([^/]+)\/domain\//;
const TEST_FILE = /(^|\/)__tests__\/|\.test\.tsx?$/;

export function fileViolations(baseDir: string): Violation[] {
  return listFiles(baseDir, 'src/modules')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
    .flatMap((path) => {
      const module = DOMAIN_FILE.exec(path)?.[1];
      if (!module || !FILE_RULE_MODULES.has(module) || TEST_FILE.test(path)) return [];
      const source = ts.createSourceFile(
        path,
        readFileSync(join(baseDir, path), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const functions = exportedFunctions(source);
      const found: Violation[] = [];
      if (ENTITY_FILE.test(path)) {
        const classes = exportedClassNames(source);
        if (classes.length > 1) {
          found.push({
            rule: 'api-entity-file-exports-one-class-and-no-function',
            from: path,
            to: `exports ${classes.length} classes`,
          });
        }
        for (const fn of functions) {
          found.push({
            rule: 'api-entity-file-exports-one-class-and-no-function',
            from: path,
            to: `exports the function ${fn.name}`,
          });
        }
      }
      for (const fn of functions.filter((candidate) => !candidate.typeGuard)) {
        found.push({
          rule: 'api-domain-exports-no-function-but-type-guards',
          from: path,
          to: `exports the function ${fn.name}`,
        });
      }
      return found;
    });
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

function exportedClassNames(source: ts.SourceFile): string[] {
  const later = exportedLater(source);
  return source.statements
    .filter(ts.isClassDeclaration)
    .filter(
      (declaration) =>
        isExported(declaration) || (declaration.name && later.has(declaration.name.text)),
    )
    .map((declaration) => declaration.name?.text ?? 'default');
}

interface ExportedFunction {
  name: string;
  typeGuard: boolean;
}

/** A `value is T` return type: the one kind of function `domain/` may export. */
function isTypeGuard(declaration: ts.SignatureDeclaration): boolean {
  return (
    declaration.type !== undefined &&
    ts.isTypePredicateNode(declaration.type) &&
    declaration.type.assertsModifier === undefined
  );
}

function functionLike(node: ts.Expression | undefined): ts.SignatureDeclaration | undefined {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current))) {
    current = current.expression;
  }
  return current && (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    ? current
    : undefined;
}

/**
 * Functions a file exports: function declarations and variables initialised with an arrow or
 * function expression, whether exported where declared or by a later `export { name }`.
 */
function exportedFunctions(source: ts.SourceFile): ExportedFunction[] {
  const later = exportedLater(source);
  const found: ExportedFunction[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      if (isExported(statement) || later.has(name)) {
        found.push({ name, typeGuard: isTypeGuard(statement) });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const fn = functionLike(declaration.initializer);
        const name = declaration.name.text;
        if (fn && (isExported(statement) || later.has(name))) {
          found.push({ name, typeGuard: isTypeGuard(fn) });
        }
      }
    }
  }
  return found;
}
