import ts from 'typescript';
import { listFiles, type Violation } from '../harness';
import {
  exportedClasses,
  exportedLater,
  hasExportModifier,
  isErrorClass,
  parse,
  unwrapExpression,
  type ExportedClass,
} from './syntax';

/** Syntax-only checks for value objects owning their rules (backend.md §3 rule 9 and §10). */
export const VALUE_OBJECT_RULES = [
  'api-value-object-constant-needs-a-class',
  'api-value-object-file-is-one-concept',
  'api-domain-no-factories-directory',
  'api-domain-no-class-of-methods-returning-another-class',
];

const VALUE_OBJECT_FILE = /^src\/modules\/([^/]+)\/domain\/value-objects\/[^/]+\.ts$/;
const DOMAIN_FILE = /^src\/modules\/([^/]+)\/domain\//;
const TEST_FILE = /(^|\/)__tests__\/|\.test\.tsx?$/;
const FACTORIES_DIRECTORY = /^(src\/modules\/[^/]+\/(?:domain|application))\/(?:.*\/)?factories\//;
/** Types a method may return without that being "another class" of the domain. */
const PLAIN_TYPES = new Set([
  'Array',
  'ReadonlyArray',
  'Date',
  'Map',
  'ReadonlyMap',
  'Set',
  'ReadonlySet',
  'Promise',
  'Record',
  'Partial',
  'Readonly',
  'Pick',
  'Omit',
  'Extract',
  'Exclude',
]);

export function valueObjectViolations(baseDir: string): Violation[] {
  const files = listFiles(baseDir, 'src/modules').filter(
    (path) => path.endsWith('.ts') && !path.endsWith('.d.ts'),
  );
  const found: Violation[] = [];
  const reportedDirectories = new Set<string>();
  for (const path of files) {
    const directory = FACTORIES_DIRECTORY.exec(path);
    if (directory && !reportedDirectories.has(directory[1]!)) {
      reportedDirectories.add(directory[1]!);
      found.push({
        rule: 'api-domain-no-factories-directory',
        from: `${directory[1]}/factories/`,
      });
    }
    if (!DOMAIN_FILE.test(path) || TEST_FILE.test(path)) continue;
    const source = parse(baseDir, path);
    if (VALUE_OBJECT_FILE.test(path)) found.push(...valueObjectFileViolations(path, source));
    found.push(...methodOnlyClassViolations(path, source));
  }
  return found;
}

/** `expr as const`, `expr satisfies T`: the literal the list is written as. */
function isLiteralValue(node: ts.Expression): boolean {
  const current = unwrapExpression(node);
  if (!current) return false;
  if (
    ts.isStringLiteralLike(current) ||
    ts.isNumericLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(current)) return isLiteralValue(current.operand);
  if (ts.isArrayLiteralExpression(current)) return current.elements.every(isLiteralValue);
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.every(
      (property) => ts.isPropertyAssignment(property) && isLiteralValue(property.initializer),
    );
  }
  return false;
}

/** A list of allowed values: an array or an object of literals, asserted `as const`. */
function isListOfAllowedValues(declaration: ts.VariableDeclaration): boolean {
  const initializer = declaration.initializer;
  const current = unwrapExpression(initializer);
  if (!initializer || !current) return false;
  if (!ts.isArrayLiteralExpression(current) && !ts.isObjectLiteralExpression(current)) return false;
  return isLiteralValue(initializer) && isAsConst(initializer);
}

function isAsConst(node: ts.Expression): boolean {
  let current: ts.Expression | undefined = node;
  while (current) {
    if (
      ts.isAsExpression(current) &&
      ts.isTypeReferenceNode(current.type) &&
      current.type.typeName.getText() === 'const'
    ) {
      return true;
    }
    current =
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
        ? current.expression
        : undefined;
  }
  return false;
}

/** The names of the exported constants of a file with the declaration of each. */
function exportedConstants(
  source: ts.SourceFile,
): { name: string; declaration: ts.VariableDeclaration }[] {
  const later = exportedLater(source);
  const found: { name: string; declaration: ts.VariableDeclaration }[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (initializer && (ts.isClassExpression(initializer) || ts.isArrowFunction(initializer))) {
        continue;
      }
      if (hasExportModifier(statement) || later.has(declaration.name.text)) {
        found.push({ name: declaration.name.text, declaration });
      }
    }
  }
  return found;
}

type TypeKind = 'record' | 'list-type';

/** A literal union, `(typeof LIST)[number]`, `Extract<…>`, or a branded id: not a record. */
function typeAliasKind(node: ts.TypeNode): TypeKind {
  if (ts.isParenthesizedTypeNode(node)) return typeAliasKind(node.type);
  if (
    ts.isLiteralTypeNode(node) ||
    ts.isIndexedAccessTypeNode(node) ||
    node.kind === ts.SyntaxKind.StringKeyword
  ) {
    return 'list-type';
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    return name === 'Extract' || name === 'Exclude' ? 'list-type' : 'record';
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.every((member) => typeAliasKind(member) === 'list-type')
      ? 'list-type'
      : 'record';
  }
  if (ts.isIntersectionTypeNode(node)) {
    const brand = node.types.some((member) => member.kind === ts.SyntaxKind.StringKeyword);
    return brand ? 'list-type' : 'record';
  }
  return 'record';
}

/** The exported records of a file: interfaces and type aliases that are not lists or brands. */
function exportedRecords(source: ts.SourceFile): string[] {
  const later = exportedLater(source);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isInterfaceDeclaration(statement) &&
      (hasExportModifier(statement) || later.has(statement.name.text))
    ) {
      found.push(statement.name.text);
    } else if (
      ts.isTypeAliasDeclaration(statement) &&
      (hasExportModifier(statement) || later.has(statement.name.text)) &&
      typeAliasKind(statement.type) === 'record'
    ) {
      found.push(statement.name.text);
    }
  }
  return found;
}

function valueObjectFileViolations(path: string, source: ts.SourceFile): Violation[] {
  const found: Violation[] = [];
  const classes = exportedClasses(source).filter((exported) => !isErrorClass(exported));
  if (classes.length === 0) {
    for (const { name, declaration } of exportedConstants(source)) {
      if (!isListOfAllowedValues(declaration)) {
        found.push({
          rule: 'api-value-object-constant-needs-a-class',
          from: path,
          to: `exports the constant ${name}, which is not a list of allowed values, and no class`,
        });
      }
    }
  }
  const records = exportedRecords(source);
  if (classes.length > 1) {
    found.push({
      rule: 'api-value-object-file-is-one-concept',
      from: path,
      to: `exports ${classes.length} classes: ${classes.map((exported) => exported.name).join(', ')}`,
    });
  }
  if (classes.length === 0 && records.length > 1) {
    found.push({
      rule: 'api-value-object-file-is-one-concept',
      from: path,
      to: `exports ${records.length} records: ${records.join(', ')}`,
    });
  }
  if (classes.length === 1) {
    const own = classes[0]!.name;
    for (const record of records.filter((name) => !name.startsWith(own))) {
      found.push({
        rule: 'api-value-object-file-is-one-concept',
        from: path,
        to: `exports the record ${record}, which is not named after the class ${own}`,
      });
    }
  }
  return found;
}

/** A class member that is not private or protected, by its modifiers. */
function isPublicMember(member: ts.ClassElement): boolean {
  if (!ts.canHaveModifiers(member)) return true;
  return !(ts.getModifiers(member) ?? []).some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

/** The class a return type names, if it names one other than `own` (through `| null`). */
function otherClassName(type: ts.TypeNode | undefined, own: string): string | undefined {
  if (!type) return undefined;
  if (ts.isUnionTypeNode(type)) {
    const names = type.types
      .filter(
        (member) =>
          member.kind !== ts.SyntaxKind.UndefinedKeyword &&
          !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
      )
      .map((member) => otherClassName(member, own));
    return names.length === 1 ? names[0] : undefined;
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText();
    if (name === own || PLAIN_TYPES.has(name) || !/^[A-Z]/.test(name)) return undefined;
    return name;
  }
  return undefined;
}

function classHasOnlyMethodsReturningOtherClasses(exported: ExportedClass): string | undefined {
  const members = exported.node.members.filter(
    (member) => !ts.isConstructorDeclaration(member) && isPublicMember(member),
  );
  if (members.length === 0) return undefined;
  const constructorProperties = exported.node.members
    .filter(ts.isConstructorDeclaration)
    .flatMap((constructor) => constructor.parameters)
    .filter((parameter) =>
      (ts.getModifiers(parameter) ?? []).some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PublicKeyword ||
          modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
      ),
    );
  if (constructorProperties.length > 0) return undefined;
  const returned = new Set<string>();
  for (const member of members) {
    if (!ts.isMethodDeclaration(member)) return undefined;
    const other = otherClassName(member.type, exported.name);
    if (other === undefined) return undefined;
    returned.add(other);
  }
  return [...returned].join(', ');
}

/** A class that only builds other classes is a factory in disguise (rule 9). */
function methodOnlyClassViolations(path: string, source: ts.SourceFile): Violation[] {
  return exportedClasses(source).flatMap((exported) => {
    const returned = classHasOnlyMethodsReturningOtherClasses(exported);
    return returned === undefined
      ? []
      : [
          {
            rule: 'api-domain-no-class-of-methods-returning-another-class',
            from: path,
            to: `${exported.name} only has methods returning ${returned}`,
          },
        ];
  });
}
