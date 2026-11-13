import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { Violation } from '../harness';

/**
 * Styling rules of `architecture:web` (docs/architecture/frontend.md, "Styling and UI
 * components") that Dependency Cruiser cannot express: it does not read CSS, and colour
 * literals and `style=` values are not import edges. Syntax only: each file is parsed on
 * its own, so the rules also work on fixtures whose npm imports do not resolve.
 */
export const STYLING_RULES = [
  'web-no-design-system-imports',
  'web-no-colour-literals',
  'web-no-style-colours',
];

export function stylingViolations(baseDir: string): Violation[] {
  return [...designSystemImportViolations(baseDir), ...colourViolations(baseDir)];
}

/** Directories never scanned: dependencies and build output. */
const IGNORED_DIRS = new Set(['node_modules', '.next', 'out', 'build', 'dist', 'coverage']);
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const CSS_FILE = /\.css$/;
/** Manifests that can point an alias or a dependency at a path: tsconfig `paths`, package.json. */
const MANIFEST_FILE = /(^|\/)(tsconfig[^/]*|package)\.json$/;

/**
 * `design-system/` is a reference export, never a dependency: no script or stylesheet of an
 * app imports from it (by relative path or package name), and no tsconfig alias or package.json
 * entry points at it, so the app never builds on files that a re-export can change underneath
 * it. `globals.css` is an owned copy instead.
 */
export function designSystemImportViolations(baseDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const path of filesBelow(baseDir, '.')) {
    const extract = specifierExtractor(path);
    if (!extract) continue;
    const specifiers = extract(readFileSync(join(baseDir, path), 'utf8'));
    for (const specifier of specifiers) {
      if (specifier.split(/[\\/]/).includes('design-system')) {
        violations.push({ rule: 'web-no-design-system-imports', from: path, to: specifier });
      }
    }
  }
  return violations;
}

function specifierExtractor(path: string): ((text: string) => string[]) | undefined {
  if (CSS_FILE.test(path)) return cssSpecifiers;
  if (SCRIPT_FILE.test(path)) return (text) => scriptSpecifiers(path, text);
  if (MANIFEST_FILE.test(path)) return jsonStrings;
  return undefined;
}

/** The only file under src/ that may define raw colours: the owned design-system theme. */
const THEME_FILE = 'src/app/globals.css';

/**
 * Colours come from the tokens of `src/app/globals.css`: no hex, rgb(), hsl() (or other CSS
 * colour function) literal anywhere else under src/, and no colour value in a `style=` prop,
 * whether literal or not. `className` token utilities (`bg-surface`, `text-brand`) are the way.
 */
function colourViolations(baseDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const path of filesBelow(baseDir, 'src')) {
    if (path === THEME_FILE) continue;
    if (CSS_FILE.test(path)) {
      const text = stripCssComments(readFileSync(join(baseDir, path), 'utf8'));
      for (const literal of colourLiterals(text)) {
        violations.push({ rule: 'web-no-colour-literals', from: path, to: literal });
      }
    } else if (SCRIPT_FILE.test(path) && !path.endsWith('.d.ts')) {
      const source = parse(path, readFileSync(join(baseDir, path), 'utf8'));
      violations.push(...scriptColourViolations(path, source));
    }
  }
  return violations;
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, not part of a longer word. */
const HEX_COLOUR = /(?<![\w&#])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
/** CSS colour functions; `color-mix()` over tokens is fine, so it is not listed. */
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;

/** An in-page anchor such as `href="#feed"` looks like hex but is not a colour. */
const FRAGMENT_HREF = /^#[\w-]*$/;

function colourLiterals(text: string): string[] {
  return [...text.matchAll(HEX_COLOUR), ...text.matchAll(COLOUR_FUNCTION)].map((match) => match[0]);
}

function scriptColourViolations(path: string, source: ts.SourceFile): Violation[] {
  const violations: Violation[] = [];
  const visit = (node: ts.Node) => {
    if (isTextLiteral(node) && !isFragmentHref(node)) {
      for (const literal of colourLiterals(node.text)) {
        violations.push({ rule: 'web-no-colour-literals', from: path, to: literal });
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'style') {
      for (const problem of styleColourProblems(node, source)) {
        violations.push({ rule: 'web-no-style-colours', from: path, to: problem });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function isTextLiteral(node: ts.Node): node is ts.LiteralLikeNode {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/** `href="#add"`: an in-page anchor, not a colour. */
function isFragmentHref(node: ts.LiteralLikeNode): boolean {
  const parent = node.parent;
  return (
    ts.isJsxAttribute(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === 'href' &&
    FRAGMENT_HREF.test(node.text)
  );
}

/**
 * A `style=` prop may set layout values only. It must be an inline object literal whose keys
 * can be read statically (a variable, spread or computed key cannot be checked), and no key
 * may be a property that carries a colour, whatever its value: `var(--brand)` belongs in a
 * `className` token utility, not in `style`.
 */
function styleColourProblems(attribute: ts.JsxAttribute, source: ts.SourceFile): string[] {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) {
    return carriesColour(initializer.text) ? [initializer.text] : [];
  }
  const expression = ts.isJsxExpression(initializer) ? initializer.expression : undefined;
  if (!expression || !ts.isObjectLiteralExpression(expression)) {
    return [`style=${initializer.getText(source)} is not an inline object literal`];
  }
  const problems: string[] = [];
  for (const property of expression.properties) {
    const key = staticKey(property);
    if (key === undefined) {
      problems.push(`${property.getText(source)} cannot be checked`);
    } else if (carriesColour(key)) {
      problems.push(key);
    }
  }
  return problems;
}

function staticKey(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isSpreadAssignment(property) || !property.name) return undefined;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** CSS properties (camelCase, kebab-case or custom `--*`) that can carry a colour. */
const COLOUR_PROPERTIES = new Set(
  [
    'background',
    'backgroundImage',
    'border',
    'borderTop',
    'borderRight',
    'borderBottom',
    'borderLeft',
    'borderBlock',
    'borderBlockStart',
    'borderBlockEnd',
    'borderInline',
    'borderInlineStart',
    'borderInlineEnd',
    'boxShadow',
    'columnRule',
    'fill',
    'outline',
    'stroke',
    'textDecoration',
    'textEmphasis',
    'textShadow',
    'webkitTextStroke',
  ].map(normalisePropertyName),
);

function carriesColour(property: string): boolean {
  // A whole declaration string (`style="color: red"`) or a single key.
  return property
    .split(';')
    .map((declaration) => normalisePropertyName(declaration.split(':')[0] ?? ''))
    .some(
      (name) => name.endsWith('color') || name.endsWith('colour') || COLOUR_PROPERTIES.has(name),
    );
}

function normalisePropertyName(name: string): string {
  return name.replace(/[^a-zA-Z]/g, '').toLowerCase();
}

/** Module specifiers of a script: imports, re-exports, `import()`, `require()`, `import x = require()`. */
function scriptSpecifiers(path: string, text: string): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression)) {
      specifiers.push(node.expression.text);
    } else if (ts.isCallExpression(node) && isImportOrRequire(node)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) specifiers.push(first.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return specifiers;
}

function isImportOrRequire(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === 'require';
  // require.resolve('…')
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'require'
  );
}

/**
 * Paths a stylesheet pulls in: `@import`, Tailwind's `@source`, `@plugin`, `@config` and
 * `@reference`, and every `url()`.
 */
const CSS_AT_RULE = /@(?:import|source|plugin|config|reference)\s+(?:url\(\s*)?(['"])(.*?)\1/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;

function cssSpecifiers(text: string): string[] {
  const css = stripCssComments(text);
  return [...css.matchAll(CSS_AT_RULE), ...css.matchAll(CSS_URL)].map((match) => match[2] ?? '');
}

/** Every string (keys and values) of a JSON file, without parsing it (tsconfig allows comments). */
function jsonStrings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parse(path: string, text: string): ts.SourceFile {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** POSIX paths (relative to `baseDir`) of the files below `dir`, skipping IGNORED_DIRS. */
function filesBelow(baseDir: string, dir: string): string[] {
  const files: string[] = [];
  const walk = (absolute: string) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(child);
      } else if (entry.isFile()) {
        files.push(relative(baseDir, child).split(sep).join('/'));
      }
    }
  };
  walk(join(baseDir, dir));
  return files.sort();
}
