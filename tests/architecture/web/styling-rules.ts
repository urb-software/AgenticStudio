import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { Violation } from '../harness';

/** Styling rules Dependency Cruiser cannot express: it reads no CSS. */
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
/** Build and tool configs that can alias a path (`resolveAlias`, Tailwind, PostCSS, Vitest). */
const CONFIG_FILE = /(^|\/)(next|postcss|tailwind|vitest)\.config\.[^/]+$/;

/**
 * `design-system/` is a reference export, never a dependency (`globals.css` is an owned copy).
 * Every kind of file is checked for a `design-system` path segment, in the places that can load
 * it: import-like calls, config strings (aliases are plain strings), stylesheet at-rules, JSON.
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

/** Module specifiers of a script: imports, re-exports, `import()` and `require()` forms. */
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

/** Every string of a JSON file, without parsing it (tsconfig allows comments). */
function jsonStrings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
}

/** The only file under src/ that may define raw colours: the owned design-system theme. */
const THEME_FILE = 'src/app/globals.css';

/** Colours come from the tokens of `src/app/globals.css`, never from literals or `style=`. */
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

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, not part of a longer word, entity or URL. */
const HEX_COLOUR = /(?<![A-Za-z0-9&#/])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
/**
 * A CSS colour function followed by colour arguments (a number, `var(`, `#`, relative-colour
 * `from`, `none`, or a colour space), so prose such as `color(optional)` is not one.
 * `color-mix()` over tokens is fine, so it is not listed.
 */
const COLOUR_FUNCTION_NAME = /(?<![A-Za-z0-9-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
/** What may open the arguments: a number, `#`, `from`, `none`, a colour space or a nested call. */
const COLOUR_ARGUMENTS =
  /^\s*(?:[\d.+\-#]|from\b|none\b|srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|[a-z][\w-]*\()/i;

/** Colour function calls, found by balanced-parenthesis scanning so `rgb(calc(…))` is whole. */
function colourFunctions(text: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(COLOUR_FUNCTION_NAME)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')') depth--;
      end++;
    }
    if (COLOUR_ARGUMENTS.test(text.slice(start, end))) calls.push(text.slice(match.index, end));
  }
  return calls;
}

const DATA_URI_HEX = /(?:#|%23)(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;

/**
 * Colours inside a `data:` URI: `#hex` or URL-encoded `%23hex`, and colour functions. Base64
 * payloads are not decoded (out of scope).
 */
function dataUriColours(text: string): string[] {
  if (!/data:[a-z]+\/[^,;]*[;,]/i.test(text)) return [];
  return [...[...text.matchAll(DATA_URI_HEX)].map((match) => match[0]), ...colourFunctions(text)];
}

/**
 * In stylesheets, only declaration values (`prop: value`, `$var: value`, `--token: value`) and
 * `@apply` lists are checked, so id selectors such as `#add { }` are not colours. Every hex
 * token or colour function in a value is one.
 */
function stylesheetColours(path: string, text: string): string[] {
  const css = stripStylesheetComments(path, text);
  const values = [
    ...stylesheetDeclarationValues(path, css),
    ...applyLists(css),
    ...mixinArguments(path, css),
  ];
  const dataUris = [...css.matchAll(/url\(\s*(['"]?)(data:[\s\S]*?)\1\s*\)/gi)].map(
    (match) => match[2] ?? '',
  );
  return [
    ...values.flatMap((value) => [
      ...[...value.matchAll(HEX_COLOUR)].map((match) => match[0]),
      ...colourFunctions(value),
    ]),
    ...dataUris.flatMap(dataUriColours),
  ];
}

/** Arguments of SCSS `@include mixin(…)` (Sass: `+mixin(…)`) calls, which are not declarations. */
function mixinArguments(path: string, css: string): string[] {
  const call = path.endsWith('.sass')
    ? /^\s*\+[\w-]+\(([^\n]*)/gm
    : /@include\s+[\w.-]+\s*\(([^;{]*)/g;
  return [...css.matchAll(call)].map((match) => match[1] ?? '');
}

/** Values of `prop: value`, `$var: value` and `--token: value` declarations (comments stripped). */
function stylesheetDeclarationValues(path: string, css: string): string[] {
  const declaration = path.endsWith('.sass')
    ? /^\s*(?:[\w-]+|\$[\w-]+)\s*:\s+(.*)$/gm
    : /(?<![\w-])(?:[\w-]+|\$[\w-]+)\s*:\s*([^;{}]*)(?=[;}]|$)/g;
  return [...css.matchAll(declaration)].map((match) => match[1] ?? '');
}

/** Class lists of `@apply` rules (comments stripped). */
function applyLists(css: string): string[] {
  return [...css.matchAll(/@apply\s+([^;{}\n]*)/g)].map((match) => match[1] ?? '');
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
    if (isTextLiteral(node) && !isSelectorOrHref(node, node.text)) {
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

/** A reference word (PR, Refs, Issue, Epic, commit) right before the `#`. */
const REFERENCE_BEFORE = /(?<![A-Za-z])(?:PRs?|Refs?|Issues?|Epic|commit)\s+$/i;
/** Digits only after `of` is a reference too: test titles read "review of" a ticket. */
const OF_BEFORE = /(?<![A-Za-z])of\s+$/i;

/**
 * `#` also starts ticket references, so a hex token is a reference only right after a reference
 * word; any other is a colour. Trade-off: a bare `'#feed'` or `'#cafe'` is a valid `#RGBA` colour
 * and fails (write the id as `[id="feed"]` or without `#`).
 */
function scriptColourLiterals(text: string): string[] {
  const hexes = [...text.matchAll(HEX_COLOUR)]
    .filter((match) => {
      const before = text.slice(0, match.index);
      return !(
        REFERENCE_BEFORE.test(before) ||
        (OF_BEFORE.test(before) && /^#\d+$/.test(match[0]))
      );
    })
    .map((match) => match[0]);
  return [...hexes, ...colourFunctions(text), ...dataUriColours(text)];
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

/**
 * A string in the `href` of a link (`<a>`, `Link`) or a selector-method argument. Trade-off: a
 * selector that is more than a bare hex is exempt whole (`matches('#ff0000 > a')` passes,
 * `matches('#ff0000')` fails); `<Swatch href="#ff0000">` fails, as it is not a link.
 */
function isSelectorOrHref(node: ts.Node, text: string): boolean {
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
    return ts.isIdentifier(current.name) && current.name.text === 'href' && isLink(current);
  }
  if (ts.isCallExpression(current)) {
    const callee = current.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : undefined;
    return name !== undefined && SELECTOR_METHODS.has(name) && !/^\s*#[0-9a-f]+\s*$/i.test(text);
  }
  return false;
}

function isLink(attribute: ts.JsxAttribute): boolean {
  const tag = attribute.parent.parent.tagName;
  return ts.isIdentifier(tag) && (tag.text === 'a' || tag.text === 'Link');
}

/**
 * A `style=` prop is an inline object literal with static keys (others cannot be checked) and sets
 * layout only: a colour-capable property is refused whatever its value, any other when it
 * holds one.
 */
function styleColourProblems(attribute: ts.JsxAttribute, source: ts.SourceFile): string[] {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) {
    const text = initializer.text;
    const declarations = text.split(';').map((d) => d.split(':'));
    const colourful = declarations.some(
      ([property = '', value = '']) => carriesColour(property) || holdsColour(value, property),
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
      if (value !== undefined && holdsColour(value, key)) problems.push(`${key}: ${value}`);
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

/** Properties whose value is a name or a font, never a colour: `fontFamily: 'Gold Sans'`. */
const NAME_PROPERTIES = new Set(
  ['fontFamily', 'font', 'animationName', 'animation', 'transitionProperty', 'content'].map(
    normalisePropertyName,
  ),
);

/** Any hex token, colour function or (except on name properties) CSS named colour in a value. */
function holdsColour(value: string, property: string): boolean {
  return (
    [...value.matchAll(HEX_COLOUR)].length > 0 ||
    colourFunctions(value).length > 0 ||
    (!NAME_PROPERTIES.has(normalisePropertyName(property)) &&
      (value.match(/[a-z]+/gi) ?? []).some((word) => NAMED_COLOURS.has(word.toLowerCase())))
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

/**
 * Colour utilities must name a token, not Tailwind's palette. Exception: `bg-black/<n>` and
 * `bg-white/<n>` in `src/shared/ui/**` (no overlay token). All strings are scanned: class names
 * reach `className` through `cn()` and `cva()`.
 */
function paletteViolations(baseDir: string): Violation[] {
  return filesBelow(baseDir, 'src').flatMap((path) =>
    paletteViolationsInFile(path, readFileSync(join(baseDir, path), 'utf8')),
  );
}

/** Where `bg-black/<n>` / `bg-white/<n>` is allowed (overlay scrims). */
const SCRIM_DIR = 'src/shared/ui/';

export function paletteViolationsInFile(path: string, text: string): Violation[] {
  if (STYLESHEET.test(path)) {
    const css = stripStylesheetComments(path, text);
    // Declarations can reach the palette only through its variables or theme().
    const declarationHits = stylesheetDeclarationValues(path, css)
      .flatMap((value) => value.split(/\s+/))
      .filter(isPaletteReference)
      .map((token) => ({ rule: 'web-no-palette-utilities', from: path, to: token }));
    return [...declarationHits, ...classListViolations(path, applyLists(css))];
  }
  if (SCRIPT_FILE.test(path) && !path.endsWith('.d.ts')) {
    return classListViolations(path, scriptClassLists(parse(path, text)));
  }
  return [];
}

function classListViolations(path: string, classLists: string[]): Violation[] {
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
  'border-bs',
  'border-be',
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
const BLACK_WHITE = new RegExp(`^(${PREFIX})-(?:black|white)(${OPACITY})?$`);
const ARBITRARY_NAMED = new RegExp(String.raw`^${PREFIX}-\[(?:color:)?([a-z]+)\]${OPACITY}?$`, 'i');

/** Palette variables exist because globals.css imports `tailwindcss`; never allowed, even for scrims. */
const PALETTE_VARIABLE = new RegExp(
  `--color-(?:(?:${PALETTE})-(?:${SHADE})|black|white)(?![\\w-])`,
);
/** `theme(colors.red.500)` / `theme(colors.black)`: the v3-style path to the palette. */
const THEME_PALETTE = new RegExp(
  String.raw`theme\(\s*colors\.(?:(?:${PALETTE})\.(?:${SHADE})|black|white)(?![\w-])`,
);
/** An arbitrary property with a named colour value: `[background-color:red]`. */
const ARBITRARY_PROPERTY = /^\[[a-z-]+:([a-z]+)\]$/i;

/** A palette variable or a theme() palette path anywhere in a token or declaration value. */
function isPaletteReference(token: string): boolean {
  return PALETTE_VARIABLE.test(token) || THEME_PALETTE.test(token);
}

function isPaletteUtility(token: string, scrimsAllowed: boolean): boolean {
  if (isPaletteReference(token)) return true;
  const utility = withoutVariants(token).replace(/^!|!$/g, '');
  if (PALETTE_UTILITY.test(utility)) return true;
  const blackWhite = BLACK_WHITE.exec(utility);
  // The scrim exception: a background with an opacity modifier, nothing else.
  if (blackWhite) return !(scrimsAllowed && blackWhite[1] === 'bg' && blackWhite[2] !== undefined);
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
