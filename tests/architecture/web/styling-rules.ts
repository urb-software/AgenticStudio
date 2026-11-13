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
  'web-no-palette-utilities',
];

export function stylingViolations(baseDir: string): Violation[] {
  return [
    ...designSystemImportViolations(baseDir),
    ...colourViolations(baseDir),
    ...paletteViolations(baseDir),
  ];
}

/** Directories never scanned: dependencies and build output. */
const IGNORED_DIRS = new Set(['node_modules', '.next', 'out', 'build', 'dist', 'coverage']);
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const STYLESHEET = /\.(?:css|scss|sass)$/;
/** Manifests that can point an alias or a dependency at a path. */
const MANIFEST_FILE = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|package|components)\.json$/;
/** Build configs that can alias a path (webpack/turbopack `resolveAlias`, PostCSS options). */
const CONFIG_FILE = /(^|\/)(next|postcss)\.config\.[cm]?[jt]s$/;

// ---------------------------------------------------------------------------------------------
// web-no-design-system-imports
// ---------------------------------------------------------------------------------------------

/**
 * `design-system/` is a reference export, never a dependency, so the app never builds on files
 * that a re-export can change underneath it (`globals.css` is an owned copy instead). Every
 * file of an app is checked for a path with a `design-system` segment:
 * - scripts: import/re-export specifiers, `import()` / `require()` / `require.resolve()`
 *   arguments, including statically visible concatenations and template literals;
 * - `next.config.*` / `postcss.config.*`: every string, since aliases are plain strings there;
 * - stylesheets: `@import`, `@use`, `@forward`, Tailwind's `@source` / `@plugin` / `@config` /
 *   `@reference`, and `url()`;
 * - tsconfig / jsconfig / package.json / shadcn `components.json`: every string.
 */
export function designSystemImportViolations(baseDir: string): Violation[] {
  return filesBelow(baseDir, '.').flatMap((path) =>
    designSystemViolationsInFile(path, readFileSync(join(baseDir, path), 'utf8')),
  );
}

export function designSystemViolationsInFile(path: string, text: string): Violation[] {
  return pathsReferencedBy(path, text)
    .filter((specifier) => specifier.split(/[\\/]/).includes('design-system'))
    .map((specifier) => ({ rule: 'web-no-design-system-imports', from: path, to: specifier }));
}

function pathsReferencedBy(path: string, text: string): string[] {
  if (STYLESHEET.test(path)) return stylesheetPaths(path, text);
  if (CONFIG_FILE.test(path)) return scriptStrings(path, text);
  if (SCRIPT_FILE.test(path)) return scriptSpecifiers(path, text);
  if (MANIFEST_FILE.test(path)) return jsonStrings(text);
  return [];
}

/** Stands for a part of a string that is not statically known. */
const UNKNOWN = '\u0000';

/** The static text of a string expression (`'a' + b`, `` `a${b}` ``), unknown parts as UNKNOWN. */
function staticText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (staticText(node.left) ?? UNKNOWN) + (staticText(node.right) ?? UNKNOWN);
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map((span) => (staticText(span.expression) ?? UNKNOWN) + span.literal.text)
        .join('')
    );
  }
  return undefined;
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
      const specifier = first && staticText(first);
      if (specifier !== undefined) specifiers.push(specifier);
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

/** Every string a config script spells out, including static concatenations. */
function scriptStrings(path: string, text: string): string[] {
  const strings: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const value = staticText(node as ts.Expression);
      if (value !== undefined) strings.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return strings;
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

const STYLESHEET_AT_RULE =
  /@(?:import|use|forward|source|plugin|config|reference)\s+(?:url\(\s*)?(['"])(.*?)\1/g;
const STYLESHEET_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;

function stylesheetPaths(path: string, text: string): string[] {
  const css = stripStylesheetComments(path, text);
  return [...css.matchAll(STYLESHEET_AT_RULE), ...css.matchAll(STYLESHEET_URL)].map(
    (match) => match[2] ?? '',
  );
}

/** Every string (keys and values) of a JSON file, without parsing it (tsconfig allows comments). */
function jsonStrings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
}

// ---------------------------------------------------------------------------------------------
// web-no-colour-literals and web-no-style-colours
// ---------------------------------------------------------------------------------------------

/** The only file under src/ that may define raw colours: the owned design-system theme. */
const THEME_FILE = 'src/app/globals.css';

/**
 * Colours come from the tokens of `src/app/globals.css`: no hex or CSS colour function literal
 * anywhere else under src/, and no colour value in a `style=` prop, whether literal or not.
 * `className` token utilities (`bg-surface`, `text-brand`) are the way.
 */
function colourViolations(baseDir: string): Violation[] {
  return filesBelow(baseDir, 'src')
    .filter((path) => path !== THEME_FILE)
    .flatMap((path) => colourViolationsInFile(path, readFileSync(join(baseDir, path), 'utf8')));
}

export function colourViolationsInFile(path: string, text: string): Violation[] {
  if (STYLESHEET.test(path)) {
    return stylesheetColours(path, text).map((literal) => ({
      rule: 'web-no-colour-literals',
      from: path,
      to: literal,
    }));
  }
  if (SCRIPT_FILE.test(path) && !path.endsWith('.d.ts')) {
    return scriptColourViolations(path, parse(path, text));
  }
  return [];
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, not part of a longer word, entity or URL (`_` is a Tailwind space). */
const HEX_COLOUR = /(?<![A-Za-z0-9&#/])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
/**
 * A CSS colour function followed by colour arguments (a number, `var(`, `#`, relative-colour
 * `from`, `none`, or a colour space), so prose such as `color(optional)` is not one.
 * `color-mix()` over tokens is fine, so it is not listed.
 */
const COLOUR_FUNCTION =
  /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?=\s*(?:[\d.+\-#]|var\(|from\b|none\b|srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz))/gi;

function colourFunctions(text: string): string[] {
  return [...text.matchAll(COLOUR_FUNCTION)].map((match) => match[0]);
}

/**
 * In stylesheets, only declaration values (`prop: value`, `$var: value`, `--token: value`) and
 * `@apply` lists are checked, so id selectors such as `#add { }` are not colours. Every hex
 * token or colour function in a value is one.
 */
function stylesheetColours(path: string, text: string): string[] {
  const css = stripStylesheetComments(path, text);
  const declaration = path.endsWith('.sass')
    ? /^\s*(?:[\w-]+|\$[\w-]+)\s*:\s+(.*)$/gm
    : /(?<![\w-])(?:[\w-]+|\$[\w-]+)\s*:\s*([^;{}]*)(?=[;}]|$)/g;
  const values = [
    ...[...css.matchAll(declaration)].map((match) => match[1] ?? ''),
    ...[...css.matchAll(/@apply\s+([^;{}\n]*)/g)].map((match) => match[1] ?? ''),
  ];
  return values.flatMap((value) => [
    ...[...value.matchAll(HEX_COLOUR)].map((match) => match[0]),
    ...colourFunctions(value),
  ]);
}

function stripStylesheetComments(path: string, text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // Sass line comments; `://` (URLs) is kept.
  return /\.s[ac]ss$/.test(path) ? withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1') : withoutBlocks;
}

/** Methods whose string argument is a CSS selector (`'#feed'` is an id there, not a colour). */
const SELECTOR_METHODS = new Set([
  'querySelector',
  'querySelectorAll',
  'closest',
  'matches',
  'getElementById',
]);

function scriptColourViolations(path: string, source: ts.SourceFile): Violation[] {
  const violations: Violation[] = [];
  const visit = (node: ts.Node) => {
    if (isTextLiteral(node) && !isSelectorOrHref(node)) {
      for (const literal of scriptColourLiterals(node.text)) {
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

/**
 * Hex tokens in a script string are colours when the context says so, because `#` also starts
 * Issue/PR references, ids and URL fragments. A `#` followed by 3, 4, 6 or 8 hex digits (any
 * case, not part of a longer word) is a colour when:
 * - it is the whole string (`'#7c3aed'`), or
 * - it follows `[`, `(`, `,`, `:`, `_` or `=` (Tailwind arbitrary values `bg-[#fff]`,
 *   `shadow-[0_0_0_#fff]`, functions, `color: #fff`), or
 * - it follows a space and has a letter (`'1px solid #e4e4e7'`); digits only after a space
 *   (`'PR #1234'`, `'Refs #123'`) are read as references.
 * Never a colour: after a word character, `/`, `&` or `#` (`/docs/#abc`, `&#123;`), in an
 * `href`, or in a selector argument (`querySelector('#feed')`). Colour functions count only
 * with colour arguments (see COLOUR_FUNCTION).
 */
function scriptColourLiterals(text: string): string[] {
  const hexes = [...text.matchAll(HEX_COLOUR)]
    .filter((match) => {
      const token = match[0];
      const before = text.slice(0, match.index);
      const after = text.slice(match.index + token.length);
      if (before.trim() === '' && after.trim() === '') return true;
      const previous = before.trimEnd().slice(-1);
      if (previous !== '' && '[(,:_='.includes(previous)) return true;
      return !/^#\d+$/.test(token);
    })
    .map((match) => match[0]);
  return [...hexes, ...colourFunctions(text)];
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

/** A string inside an `href` (string or expression form) or a selector-method argument. */
function isSelectorOrHref(node: ts.Node): boolean {
  let current = node.parent;
  while (
    ts.isJsxExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTemplateExpression(current) ||
    ts.isTemplateSpan(current)
  ) {
    current = current.parent;
  }
  if (ts.isJsxAttribute(current)) {
    return ts.isIdentifier(current.name) && current.name.text === 'href';
  }
  if (ts.isCallExpression(current)) {
    const callee = current.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : undefined;
    return name !== undefined && SELECTOR_METHODS.has(name);
  }
  return false;
}

/**
 * A `style=` prop may set layout values only. It must be an inline object literal whose keys
 * can be read statically (a variable, spread or computed key cannot be checked). A property
 * that can carry a colour is a violation whatever its value (`var(--brand)` belongs in a
 * `className` token utility), and any other property is a violation when its literal value
 * holds a colour (hex, colour function or named colour).
 */
function styleColourProblems(attribute: ts.JsxAttribute, source: ts.SourceFile): string[] {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) {
    const text = initializer.text;
    const declarations = text.split(';').map((d) => d.split(':'));
    const colourful = declarations.some(
      ([property = '', value = '']) => carriesColour(property) || holdsColour(value),
    );
    return colourful ? [text] : [];
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
    } else if (ts.isPropertyAssignment(property)) {
      const value = staticText(property.initializer);
      if (value !== undefined && holdsColour(value)) problems.push(`${key}: ${value}`);
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
    'backdropFilter',
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
    'borderImage',
    'borderImageSource',
    'boxShadow',
    'columnRule',
    'fill',
    'filter',
    'listStyle',
    'listStyleImage',
    'mask',
    'maskImage',
    'maskBorder',
    'maskBorderSource',
    'outline',
    'stroke',
    'textDecoration',
    'textEmphasis',
    'textShadow',
    'webkitTextStroke',
  ].map(normalisePropertyName),
);

function carriesColour(property: string): boolean {
  const name = normalisePropertyName(property);
  return name.endsWith('color') || name.endsWith('colour') || COLOUR_PROPERTIES.has(name);
}

function normalisePropertyName(name: string): string {
  return name.replace(/[^a-zA-Z]/g, '').toLowerCase();
}

/** Any hex token, colour function or CSS named colour in a value. */
function holdsColour(value: string): boolean {
  return (
    [...value.matchAll(HEX_COLOUR)].length > 0 ||
    colourFunctions(value).length > 0 ||
    (value.match(/[a-z]+/gi) ?? []).some((word) => NAMED_COLOURS.has(word.toLowerCase()))
  );
}

/** CSS named colours (CSS Color 4), plus `transparent` and `currentcolor`. */
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent currentcolor'
  ).split(' '),
);

// ---------------------------------------------------------------------------------------------
// web-no-palette-utilities
// ---------------------------------------------------------------------------------------------

/**
 * Tailwind's default palette (`bg-zinc-900`, `text-red-500`, `border-white`) is an ad hoc palette
 * next to the tokens, so colour utilities must name a token (`bg-surface`, `text-run-failed/80`).
 * Named colours in arbitrary values (`bg-[red]`) are the same thing spelt differently.
 *
 * The one exception: `black` / `white` **with an opacity modifier** (`bg-black/55`) in
 * `src/shared/ui/**`, for the overlay scrims the shadcn primitives draw, because the design
 * system has no overlay token and `globals.css` stays a copy of it.
 *
 * Class names are found in every string of a script (class names reach `className` through
 * `cn()`, `cva()` variant maps and constants, so attributes alone are not enough; import
 * specifiers are skipped) and in stylesheet `@apply` lists. A string is split on whitespace and
 * each token's variants (`hover:`, `dark:md:`, `[&_svg]:`, `data-[state=open]:`) and important
 * marks (`!`) are removed before the utility is matched. Prose does not look like
 * `<prefix>-<palette>-<shade>`, so it is not matched.
 */
function paletteViolations(baseDir: string): Violation[] {
  return filesBelow(baseDir, 'src').flatMap((path) =>
    paletteViolationsInFile(path, readFileSync(join(baseDir, path), 'utf8')),
  );
}

/** Where `black` / `white` with an opacity modifier is allowed (overlay scrims). */
const SCRIM_DIR = 'src/shared/ui/';

export function paletteViolationsInFile(path: string, text: string): Violation[] {
  let classLists: string[];
  if (STYLESHEET.test(path)) {
    const css = stripStylesheetComments(path, text);
    classLists = [...css.matchAll(/@apply\s+([^;{}\n]*)/g)].map((match) => match[1] ?? '');
  } else if (SCRIPT_FILE.test(path) && !path.endsWith('.d.ts')) {
    classLists = scriptClassLists(parse(path, text));
  } else {
    return [];
  }
  const scrimsAllowed = path.startsWith(SCRIM_DIR);
  return classLists
    .flatMap((list) => list.split(/\s+/))
    .filter((token) => isPaletteUtility(token, scrimsAllowed))
    .map((token) => ({ rule: 'web-no-palette-utilities', from: path, to: token }));
}

/** Text of every string literal and template piece, except module specifiers. */
function scriptClassLists(source: ts.SourceFile): string[] {
  const lists: string[] = [];
  const visit = (node: ts.Node) => {
    if (isTextLiteral(node) && !isModuleSpecifier(node)) lists.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lists;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    ts.isExternalModuleReference(parent) ||
    (ts.isCallExpression(parent) && isImportOrRequire(parent))
  );
}

/** Tailwind utilities that take a colour (v4). Longer prefixes first. */
const COLOUR_UTILITY_PREFIXES = [
  'border-x',
  'border-y',
  'border-s',
  'border-e',
  'border-t',
  'border-r',
  'border-b',
  'border-l',
  'border',
  'ring-offset',
  'inset-ring',
  'ring',
  'inset-shadow',
  'drop-shadow',
  'text-shadow',
  'shadow',
  'outline',
  'divide',
  'decoration',
  'placeholder',
  'accent',
  'caret',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'bg',
  'text',
];

/** Tailwind v4 default palette names (tailwindcss/theme.css). */
const PALETTE =
  'slate|gray|zinc|neutral|stone|taupe|mauve|mist|olive|red|orange|amber|yellow|lime|green|' +
  'emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const SHADE = '50|100|200|300|400|500|600|700|800|900|950';
/** `/50`, `/12.5`, `/[.35]`, `/(--alpha)`. */
const OPACITY = String.raw`(?:/(?:\d+(?:\.\d+)?|\[[^\]]+\]|\([^)]+\)))`;
const PREFIX = `(?:${COLOUR_UTILITY_PREFIXES.join('|')})`;
const PALETTE_UTILITY = new RegExp(`^${PREFIX}-(?:${PALETTE})-(?:${SHADE})${OPACITY}?$`);
const BLACK_WHITE = new RegExp(`^${PREFIX}-(?:black|white)(${OPACITY})?$`);
const ARBITRARY_NAMED = new RegExp(String.raw`^${PREFIX}-\[(?:color:)?([a-z]+)\]${OPACITY}?$`, 'i');

/**
 * Tailwind's palette variables (`--color-zinc-900`, `--color-black`) exist because globals.css
 * imports `tailwindcss`; reaching them through `bg-(--color-…)` or `var(--color-…)` is the
 * same palette under another spelling, so it is never allowed (not even for scrims).
 */
const PALETTE_VARIABLE = new RegExp(
  `--color-(?:(?:${PALETTE})-(?:${SHADE})|black|white)(?![\\w-])`,
);
/** An arbitrary property with a named colour value: `[background-color:red]`. */
const ARBITRARY_PROPERTY = /^\[[a-z-]+:([a-z]+)\]$/i;

function isPaletteUtility(token: string, scrimsAllowed: boolean): boolean {
  if (PALETTE_VARIABLE.test(token)) return true;
  const utility = withoutVariants(token).replace(/^!|!$/g, '');
  if (PALETTE_UTILITY.test(utility)) return true;
  const blackWhite = BLACK_WHITE.exec(utility);
  if (blackWhite) return !(scrimsAllowed && blackWhite[1] !== undefined);
  const named = (ARBITRARY_NAMED.exec(utility) ?? ARBITRARY_PROPERTY.exec(utility))?.[1];
  return isNamedColour(named);
}

function isNamedColour(value: string | undefined): boolean {
  const name = value?.toLowerCase();
  return name !== undefined && NAMED_COLOURS.has(name) && !PLAIN_KEYWORDS.has(name);
}

/** `transparent` and `currentcolor` are not palette colours (`bg-[transparent]` is fine). */
const PLAIN_KEYWORDS = new Set(['transparent', 'currentcolor']);

/** The utility after the last variant separator (`:` outside brackets and parentheses). */
function withoutVariants(token: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
    else if (char === ':' && depth === 0) start = i + 1;
  }
  return token.slice(start);
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

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
