import ts from 'typescript';
import { listFiles, type Violation } from '../harness';
import {
  COMPANION_FILE,
  ENTITY_FILE,
  exportedClasses,
  exportedLater,
  hasExportModifier,
  parse,
  runtimeExports,
  unwrapExpression,
} from './syntax';

/** Syntax-only checks for rule 13 of backend.md §3 and for entity companions. */
export const FILE_RULES = [
  'api-entity-file-exports-one-class-and-no-function',
  'api-domain-exports-no-function-but-type-guards',
  'api-entity-companions-export-types-only',
];

const DOMAIN_FILE = /^src\/modules\/([^/]+)\/domain\//;
const TEST_FILE = /(^|\/)__tests__\/|\.test\.tsx?$/;

export function fileViolations(baseDir: string): Violation[] {
  return listFiles(baseDir, 'src/modules')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
    .flatMap((path) => {
      if (!DOMAIN_FILE.test(path) || TEST_FILE.test(path)) return [];
      const source = parse(baseDir, path);
      const functions = exportedFunctions(source);
      const found: Violation[] = [];
      if (COMPANION_FILE.test(path)) {
        for (const name of runtimeExports(source)) {
          found.push({
            rule: 'api-entity-companions-export-types-only',
            from: path,
            to: `exports ${name === '*' ? 'everything of another file with export *' : name}, which is not a type`,
          });
        }
      }
      if (ENTITY_FILE.test(path)) {
        const classes = exportedClasses(source);
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
  const current = unwrapExpression(node);
  return current && (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    ? current
    : undefined;
}

/**
 * Functions a file exports, where declared or by a later `export { name }`: declarations, arrow
 * or function expressions (also behind `as`/`satisfies`) and `export default`; an overload counts
 * once.
 */
function exportedFunctions(source: ts.SourceFile): ExportedFunction[] {
  const later = exportedLater(source);
  const declarations = new Map<string, ts.FunctionDeclaration[]>();
  const found: ExportedFunction[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      if (hasExportModifier(statement) || later.has(name)) {
        declarations.set(name, [...(declarations.get(name) ?? []), statement]);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const fn = functionLike(declaration.initializer);
        const name = declaration.name.text;
        if (fn && (hasExportModifier(statement) || later.has(name))) {
          found.push({ name, typeGuard: isTypeGuard(fn) });
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      const fn = functionLike(statement.expression);
      if (fn) found.push({ name: 'default', typeGuard: isTypeGuard(fn) });
    }
  }
  for (const [name, overloads] of declarations) {
    const visible = overloads.filter((declaration) => declaration.body === undefined);
    found.push({ name, typeGuard: (visible.length > 0 ? visible : overloads).every(isTypeGuard) });
  }
  return found;
}
