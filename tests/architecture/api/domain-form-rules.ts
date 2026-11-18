import ts from 'typescript';
import { listFiles, type Violation } from '../harness';
import {
  exportedLater,
  hasExportModifier,
  isErrorClass,
  moduleImports,
  parse,
  unwrapExpression,
} from './syntax';

/**
 * Syntax-only checks for rule 4 and 13 of backend.md §3 and the §10 table: no rule lives in a
 * static method or a top-level function of `domain/`, every class is an object, and the domain
 * reaches no runtime module.
 */
export const DOMAIN_FORM_RULES = [
  'api-domain-static-is-a-factory',
  'api-domain-top-level-function-is-a-guard-or-helper',
  'api-domain-class-has-instance-member',
  'api-domain-no-runtime-modules',
];

const DOMAIN_FILE = /^src\/modules\/([^/]+)\/domain\//;
const OBJECT_FILE = /^src\/modules\/[^/]+\/domain\/(entities|value-objects)\/.+\.ts$/;
const TEST_FILE = /(^|\/)__tests__\/|\.test\.tsx?$/;
const HELPER_MAX_LINES = 10;

/** The platform modules a domain never imports, in the `node:` form and the bare form. */
const RUNTIME_MODULES = new Set([
  'crypto',
  'fs',
  'fs/promises',
  'child_process',
  'net',
  'dns',
  'dns/promises',
  'http',
  'https',
  'tls',
  'dgram',
  'timers',
  'timers/promises',
  'worker_threads',
]);

/**
 * What the domain may import from `crypto`: hashing is deterministic and does no I/O. Random
 * sources, key generation and everything else of the module stay out, as does a default or
 * namespace import, which could reach them.
 */
const ALLOWED_CRYPTO_NAMES = new Set(['createHash']);

export function domainFormViolations(baseDir: string): Violation[] {
  return listFiles(baseDir, 'src/modules')
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
    .flatMap((path) => {
      if (!DOMAIN_FILE.test(path) || TEST_FILE.test(path)) return [];
      const source = parse(baseDir, path);
      return [
        ...(OBJECT_FILE.test(path) ? staticViolations(path, source) : []),
        ...functionViolations(path, source),
        ...instanceMemberViolations(path, source),
        ...runtimeModuleViolations(baseDir, path),
      ];
    });
}

function isPrivateOrProtected(member: ts.ClassElement): boolean {
  if (!ts.canHaveModifiers(member)) return false;
  return (ts.getModifiers(member) ?? []).some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

function isStatic(member: ts.ClassElement): boolean {
  return (
    ts.canHaveModifiers(member) &&
    (ts.getModifiers(member) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    )
  );
}

function isPrivateName(member: ts.ClassElement): boolean {
  return member.name !== undefined && ts.isPrivateIdentifier(member.name);
}

/** Every class a file declares, exported or not. */
function allClasses(source: ts.SourceFile): { name: string; node: ts.ClassDeclaration }[] {
  return source.statements
    .filter(ts.isClassDeclaration)
    .flatMap((node) => (node.name ? [{ name: node.name.text, node }] : []));
}

/** The class itself, or the class with `| undefined` or `| null`. */
function returnsOwnClass(type: ts.TypeNode | undefined, own: string): boolean {
  if (!type) return false;
  if (ts.isUnionTypeNode(type)) {
    const members = type.types.filter(
      (member) =>
        member.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
    );
    return members.length === 1 && returnsOwnClass(members[0], own);
  }
  return ts.isTypeReferenceNode(type) && type.typeName.getText() === own;
}

/** A public static method of an entity or value object is a factory: its return type is its class. */
function staticViolations(path: string, source: ts.SourceFile): Violation[] {
  const found: Violation[] = [];
  for (const exported of allClasses(source)) {
    for (const member of exported.node.members) {
      if (!isStatic(member) || isPrivateOrProtected(member) || isPrivateName(member)) continue;
      const name = member.name?.getText() ?? 'a static block';
      if (ts.isMethodDeclaration(member)) {
        if (!returnsOwnClass(member.type, exported.name)) {
          found.push({
            rule: 'api-domain-static-is-a-factory',
            from: path,
            to: `${exported.name}.${name} is a public static method that does not declare ${exported.name} as its return type`,
          });
        }
      } else if (ts.isPropertyDeclaration(member)) {
        const initializer = unwrapExpression(member.initializer);
        if (
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          found.push({
            rule: 'api-domain-static-is-a-factory',
            from: path,
            to: `${exported.name}.${name} is a public static function that does not declare ${exported.name} as its return type`,
          });
        }
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        found.push({
          rule: 'api-domain-static-is-a-factory',
          from: path,
          to: `${exported.name}.${name} is a public static accessor`,
        });
      }
    }
  }
  return found;
}

/** The names a file declares or imports from `domain/` (every relative import stays in `domain/`). */
function domainNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    } else if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith('.') &&
      statement.importClause
    ) {
      const clause = statement.importClause;
      if (clause.name) names.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.add(element.name.text);
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        names.add(bindings.name.text);
      }
    }
  }
  return names;
}

function typeNamesIn(node: ts.Node | undefined): string[] {
  if (!node) return [];
  const names: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isTypeReferenceNode(current)) {
      let name: ts.EntityName = current.typeName;
      while (ts.isQualifiedName(name)) name = name.left;
      names.push(name.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

interface TopLevelFunction {
  name: string;
  exported: boolean;
  node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
}

function topLevelFunctions(source: ts.SourceFile): TopLevelFunction[] {
  const later = exportedLater(source);
  const found: TopLevelFunction[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      found.push({
        name: statement.name.text,
        exported: hasExportModifier(statement) || later.has(statement.name.text),
        node: statement,
      });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = unwrapExpression(declaration.initializer);
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          found.push({
            name: declaration.name.text,
            exported: hasExportModifier(statement) || later.has(declaration.name.text),
            node: initializer,
          });
        }
      }
    }
  }
  return found;
}

/** An unexported helper is at most ten lines and names no domain type. */
function functionViolations(path: string, source: ts.SourceFile): Violation[] {
  const domain = domainNames(source);
  const found: Violation[] = [];
  for (const { name, exported, node } of topLevelFunctions(source)) {
    // An exported function is covered by api-domain-exports-no-function-but-type-guards.
    if (exported) continue;
    const start = source.getLineAndCharacterOfPosition(node.getStart()).line;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
    const lines = end - start + 1;
    if (lines > HELPER_MAX_LINES) {
      found.push({
        rule: 'api-domain-top-level-function-is-a-guard-or-helper',
        from: path,
        to: `${name} is ${lines} lines long, over the ${HELPER_MAX_LINES} an unexported helper may have`,
      });
    }
    const named = [
      ...new Set([
        ...node.parameters.flatMap((parameter) => typeNamesIn(parameter.type)),
        ...typeNamesIn(node.type),
      ]),
    ].filter((typeName) => domain.has(typeName));
    if (named.length > 0) {
      found.push({
        rule: 'api-domain-top-level-function-is-a-guard-or-helper',
        from: path,
        to: `${name} names the domain type ${named.join(', ')}`,
      });
    }
  }
  return found;
}

function hasInstanceMember(node: ts.ClassLikeDeclaration): boolean {
  return node.members.some((member) => {
    if (ts.isConstructorDeclaration(member)) {
      return member.parameters.some((parameter) =>
        (ts.getModifiers(parameter) ?? []).some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.PublicKeyword ||
            modifier.kind === ts.SyntaxKind.PrivateKeyword ||
            modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
            modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        ),
      );
    }
    if (isStatic(member) || ts.isClassStaticBlockDeclaration(member)) return false;
    return (
      ts.isPropertyDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    );
  });
}

/** A class that is only a namespace of statics is not an object. */
function instanceMemberViolations(path: string, source: ts.SourceFile): Violation[] {
  const found: Violation[] = [];
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    const name = statement.name.text;
    if (isErrorClass({ name, node: statement })) continue;
    if (!hasInstanceMember(statement)) {
      found.push({
        rule: 'api-domain-class-has-instance-member',
        from: path,
        to: `${name} has no instance member`,
      });
    }
  }
  return found;
}

/** Nothing in `domain/` reaches a platform runtime module: time, randomness and I/O come in as values. */
function runtimeModuleViolations(baseDir: string, path: string): Violation[] {
  return moduleImports(baseDir, path).flatMap(({ specifier, names }) => {
    const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
    if (!RUNTIME_MODULES.has(bare)) return [];
    if (bare === 'crypto' && names.length > 0 && names.every((n) => ALLOWED_CRYPTO_NAMES.has(n))) {
      return [];
    }
    const what =
      bare === 'crypto' ? `imports ${names.join(', ')} from ${specifier}` : `imports ${specifier}`;
    return [{ rule: 'api-domain-no-runtime-modules', from: path, to: what }];
  });
}
