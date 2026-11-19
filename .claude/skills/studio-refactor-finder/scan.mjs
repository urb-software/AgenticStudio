// Drift signals for one area of the repository (studio-refactor-finder). Not a check: it always
// exits 0. Every number is a signal for a reader to judge, never a verdict.
//
//   node .claude/skills/studio-refactor-finder/scan.mjs --area <api|web|agent-worker|packages|all>
//        [--base-ref <git ref>] [--top <n>] [--json] [--root <dir>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

/** An area is a set of source roots. Add one here when the repository gains an app or package. */
const AREAS = {
  api: ['apps/api/src'],
  web: ['apps/web/src'],
  'agent-worker': ['apps/agent-worker/src'],
  packages: ['packages/contracts/src', 'packages/database/src', 'packages/testing/src'],
};

const LONG_FUNCTION = 40;
const WIDE_CONSTRUCTOR = 6;
const MANY_PARAMETERS = 4;
const MANY_EXPORTS = 8;
const CHURN_DAYS = 90;

const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', 'generated', '.next']);
const isSource = (path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts');
const isTest = (path) => /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.tsx?$/.test(path);

/** Suffixes that name the role of a type. Several on one stem may be one role with several names. */
const ROLE_SUFFIXES = [
  ['stored shape', /^(?:Stored(.+)|(.+?)(?:Snapshot|Data|Record|Row|Stored))$/],
  ['outgoing shape', /^(.+?)(?:Dto|Response|View|Result|Output)$/],
  ['incoming shape', /^(.+?)(?:Request|Input|Payload|Body|Params|Args)$/],
  ['settings', /^(.+?)(?:Options|Config|Settings)$/],
];
const directoryOf = (path) => path.slice(0, path.lastIndexOf('/'));

function listFiles(root, sourceRoots) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        found.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  for (const top of sourceRoots) if (existsSync(join(root, top))) walk(join(root, top));
  return found.filter(isSource).sort();
}

const has = (node, kind) => (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
const isExported = (node) => has(node, ts.SyntaxKind.ExportKeyword);
const lineSpan = (node, source) =>
  source.getLineAndCharacterOfPosition(node.end).line -
  source.getLineAndCharacterOfPosition(node.getStart(source)).line +
  1;
const lineOf = (node, source) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** Everything one file contributes: declarations for the signals and names for the cross-file ones. */
function readFile(root, path) {
  const text = readFileSync(join(root, path), 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const file = {
    path,
    text,
    words: new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []),
    lines: text.split('\n').length,
    imports: 0,
    exports: [],
    classes: 0,
    types: [],
    constLists: [],
    statics: [],
    namespaceClasses: [],
    longFunctions: [],
    wideConstructors: [],
    manyParameters: [],
  };

  const noteFunction = (name, node) => {
    const span = lineSpan(node, source);
    const at = `${path}:${lineOf(node, source)}`;
    if (span > LONG_FUNCTION) file.longFunctions.push({ at, name, lines: span });
    if (!ts.isConstructorDeclaration(node) && node.parameters.length > MANY_PARAMETERS) {
      file.manyParameters.push({ at, name, parameters: node.parameters.length });
    }
  };

  const noteClass = (node) => {
    const name = node.name?.text ?? '(anonymous)';
    file.classes += 1;
    const decorated = (ts.getDecorators(node) ?? []).length > 0;
    const extendsSomething = (node.heritageClauses ?? []).some(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    );
    let instanceMembers = 0;
    for (const member of node.members) {
      const isStatic = has(member, ts.SyntaxKind.StaticKeyword);
      if (ts.isConstructorDeclaration(member)) {
        if (member.parameters.some((p) => (ts.getModifiers(p) ?? []).length > 0)) {
          instanceMembers += 1;
        }
        if (member.parameters.length > WIDE_CONSTRUCTOR) {
          file.wideConstructors.push({
            at: `${path}:${lineOf(member, source)}`,
            name,
            parameters: member.parameters.length,
          });
        }
        continue;
      }
      if (!isStatic) instanceMembers += 1;
      if (ts.isMethodDeclaration(member) && member.body) {
        const method = `${name}.${member.name.getText(source)}`;
        noteFunction(method, member);
        const isPrivate =
          has(member, ts.SyntaxKind.PrivateKeyword) || ts.isPrivateIdentifier(member.name);
        if (isStatic && !isPrivate && !decorated) {
          const returns = member.type?.getText(source) ?? '';
          const body = member.body.getText(source);
          const builds =
            new RegExp(`\\b${name}\\b`).test(returns) ||
            new RegExp(`new\\s+(?:${name}|this)\\s*\\(`).test(body);
          if (!builds) file.statics.push({ at: `${path}:${lineOf(member, source)}`, name: method });
        }
      }
    }
    if (instanceMembers === 0 && !decorated && !extendsSomething && node.members.length > 0) {
      file.namespaceClasses.push({ at: `${path}:${lineOf(node, source)}`, name });
    }
  };

  for (const node of source.statements) {
    if (ts.isImportDeclaration(node)) file.imports += 1;
    if (ts.isClassDeclaration(node)) {
      noteClass(node);
      if (isExported(node))
        file.exports.push({ name: node.name?.text ?? 'default', kind: 'class' });
    } else if (ts.isFunctionDeclaration(node) && node.body) {
      noteFunction(node.name?.text ?? '(default)', node);
      if (isExported(node))
        file.exports.push({ name: node.name?.text ?? 'default', kind: 'function' });
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      file.types.push(node.name.text);
      if (isExported(node)) file.exports.push({ name: node.name.text, kind: 'type' });
    } else if (ts.isEnumDeclaration(node)) {
      if (isExported(node)) file.exports.push({ name: node.name.text, kind: 'enum' });
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        let value = declaration.initializer;
        while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) {
          value = value.expression;
        }
        const isFunction = value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value));
        if (isFunction) noteFunction(name, value);
        if (value && ts.isArrayLiteralExpression(value) && value.elements.length > 1) {
          const literals = value.elements.every((e) => ts.isStringLiteralLike(e));
          if (literals) {
            file.constLists.push({
              name,
              key: value.elements
                .map((e) => e.text)
                .sort()
                .join('|'),
            });
          }
        }
        if (isExported(node)) {
          file.exports.push({ name, kind: isFunction ? 'function' : 'constant' });
        }
      }
    }
  }
  return file;
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

/** Markers that switch a tool or a rule off. Each is legitimate alone; the total is the signal. */
function escapeHatches(files, tests) {
  const production = files.map((f) => f.text).join('\n');
  const testText = tests.map((f) => f.text).join('\n');
  return {
    '@ts-ignore / @ts-expect-error / @ts-nocheck': count(
      production,
      /@ts-(?:ignore|expect-error|nocheck)/g,
    ),
    'eslint-disable': count(production, /eslint-disable/g),
    '`as any`': count(production, /\bas any\b/g),
    '`as unknown as`': count(production, /\bas unknown as\b/g),
    '@long-comment': count(production, /@long-comment/g),
    'TODO / FIXME / HACK': count(production, /\b(?:TODO|FIXME|HACK)\b/g),
    'skipped or focused tests': count(
      testText,
      /\b(?:it|test|describe)\.(?:skip|only|todo|fails)\b/g,
    ),
  };
}

/** One concept named with two suffixes of the same role, for example `RunData` and `RunSnapshot`. */
function vocabulary(files) {
  const groups = new Map();
  for (const file of files) {
    for (const name of file.types) {
      for (const [role, pattern] of ROLE_SUFFIXES) {
        const match = pattern.exec(name);
        const stem = match?.[1] ?? match?.[2];
        if (!stem) continue;
        const key = `${role}: ${stem}`;
        if (!groups.has(key)) groups.set(key, new Map());
        groups.get(key).set(name, directoryOf(file.path));
      }
    }
  }
  // Two names in different layers are often deliberate; three, or two side by side, rarely are.
  const suspicious = (names) =>
    names.size > 2 || (names.size === 2 && new Set(names.values()).size === 1);
  return [...groups]
    .filter(([, names]) => suspicious(names))
    .map(([concept, names]) => ({ concept, names: [...names.keys()].sort().join(', ') }))
    .sort((a, b) => a.concept.localeCompare(b.concept));
}

/** The same list of string values declared in more than one place. */
function duplicateLists(files) {
  const byKey = new Map();
  for (const file of files) {
    for (const list of file.constLists) {
      if (!byKey.has(list.key)) byKey.set(list.key, []);
      byKey.get(list.key).push(`${list.name} (${file.path})`);
    }
  }
  return [...byKey]
    .filter(([, places]) => places.length > 1)
    .map(([key, places]) => ({ values: key.slice(0, 60), places: places.join('; ') }));
}

/** Exports whose name appears in no other production file: unused, or kept only for a test. */
function unusedExports(files, everyProductionFile, tests) {
  const found = [];
  for (const file of files) {
    if (/(^|\/)(?:index|main|page|layout|route|error|loading|not-found)\.tsx?$/.test(file.path)) {
      continue;
    }
    for (const exported of file.exports) {
      if (exported.name === 'default') continue;
      const named = (other) => other.path !== file.path && other.words.has(exported.name);
      if (everyProductionFile.some(named)) continue;
      // A type used in its own file's signatures is exported for inference: not a signal.
      if (count(file.text, new RegExp(`\\b${exported.name}\\b`, 'g')) > 1) continue;
      found.push({
        at: file.path,
        name: exported.name,
        note: tests.some(named) ? 'tests only' : 'no reference',
      });
    }
  }
  return found;
}

function churn(root, sourceRoots, files) {
  let log;
  try {
    log = execFileSync(
      'git',
      ['log', `--since=${CHURN_DAYS} days ago`, '--name-only', '--format=', '--', ...sourceRoots],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  const commits = new Map();
  for (const line of log.split('\n')) if (line) commits.set(line, (commits.get(line) ?? 0) + 1);
  return files
    .map((file) => ({ at: file.path, commits: commits.get(file.path) ?? 0, lines: file.lines }))
    .filter((row) => row.commits > 0)
    .map((row) => ({ ...row, weight: row.commits * row.lines }))
    .sort((a, b) => b.weight - a.weight);
}

function scan(root, areaNames, withChurn = true) {
  const sourceRoots = areaNames.flatMap((name) => AREAS[name]);
  const everything = Object.values(AREAS)
    .flat()
    .flatMap((top) => listFiles(root, [top]));
  const parsed = new Map(everything.map((path) => [path, readFile(root, path)]));
  const inArea = (path) => sourceRoots.some((top) => path.startsWith(`${top}/`));
  const production = [...parsed.values()].filter((f) => !isTest(f.path));
  const allTests = [...parsed.values()].filter((f) => isTest(f.path));
  const files = production.filter((f) => inArea(f.path));
  const tests = allTests.filter((f) => inArea(f.path));
  const each = (key) => files.flatMap((f) => f[key]);

  const mixed = files
    .filter((f) => f.classes > 1 || f.exports.length > MANY_EXPORTS)
    .map((f) => ({ at: f.path, classes: f.classes, exports: f.exports.length }))
    .sort((a, b) => b.exports - a.exports);

  return {
    totals: {
      'production files': files.length,
      'production lines': files.reduce((sum, f) => sum + f.lines, 0),
      'test files': tests.length,
    },
    largest: files
      .map((f) => ({ at: f.path, lines: f.lines, imports: f.imports }))
      .sort((a, b) => b.lines - a.lines),
    mixed,
    longFunctions: each('longFunctions').sort((a, b) => b.lines - a.lines),
    wideConstructors: each('wideConstructors').sort((a, b) => b.parameters - a.parameters),
    manyParameters: each('manyParameters').sort((a, b) => b.parameters - a.parameters),
    statics: each('statics'),
    namespaceClasses: each('namespaceClasses'),
    vocabulary: vocabulary(files),
    duplicateLists: duplicateLists(production).filter((row) =>
      sourceRoots.some((top) => row.places.includes(`(${top}/`)),
    ),
    unusedExports: unusedExports(files, production, allTests),
    escapeHatches: escapeHatches(files, tests),
    churn: withChurn ? churn(root, sourceRoots, files) : [],
  };
}

const SECTIONS = [
  ['largest', 'Largest files', 'A file that keeps growing usually holds more than one concept.'],
  [
    'mixed',
    `Files with several classes or more than ${MANY_EXPORTS} exports`,
    'Grab-bag candidates.',
  ],
  [
    'longFunctions',
    `Functions and methods over ${LONG_FUNCTION} lines`,
    'Several steps in one place.',
  ],
  [
    'wideConstructors',
    `Constructors with more than ${WIDE_CONSTRUCTOR} parameters`,
    'A class with too many jobs.',
  ],
  [
    'manyParameters',
    `Functions with more than ${MANY_PARAMETERS} parameters`,
    'Values that travel together may be one type.',
  ],
  [
    'statics',
    'Public static methods that do not build their class',
    'A function attached to a class.',
  ],
  ['namespaceClasses', 'Classes with no instance member', 'A namespace, not an object.'],
  ['vocabulary', 'One concept, several names for the same role', 'Pick one name per role.'],
  [
    'duplicateLists',
    'The same list of values declared twice',
    'Two sources of truth unless a test ties them.',
  ],
  [
    'unusedExports',
    'Exports no other production file names',
    'Text search: confirm before acting.',
  ],
  [
    'churn',
    `Most changed files in ${CHURN_DAYS} days, weighted by size`,
    'Where a refactor pays back first.',
  ],
];

function table(rows, top) {
  if (rows.length === 0) return 'None.\n';
  const columns = Object.keys(rows[0]);
  const lines = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`];
  for (const row of rows.slice(0, top)) lines.push(`| ${columns.map((c) => row[c]).join(' | ')} |`);
  if (rows.length > top) lines.push(`\n${rows.length - top} more not shown (\`--top\`).`);
  return `${lines.join('\n')}\n`;
}

const delta = (now, before) => {
  if (before === undefined) return '';
  const change = now - before;
  return change === 0 ? ' (no change)' : ` (${change > 0 ? '+' : ''}${change})`;
};

function render(area, result, base, baseRef, top) {
  const out = [
    `# Drift signals: ${area}`,
    '',
    'Observations only: a row here means "look", not "change". Weigh before deciding.',
    '',
  ];
  if (baseRef) out.push(`Change shown against \`${baseRef}\`.`, '');
  out.push('| Signal | Count |', '| --- | --- |');
  for (const [name, value] of Object.entries(result.totals)) {
    out.push(`| ${name} | ${value}${delta(value, base?.totals[name])} |`);
  }
  for (const [key, title] of SECTIONS.slice(1, -1)) {
    out.push(
      `| ${title} | ${result[key].length}${delta(result[key].length, base?.[key].length)} |`,
    );
  }
  for (const [name, value] of Object.entries(result.escapeHatches)) {
    out.push(`| ${name} | ${value}${delta(value, base?.escapeHatches[name])} |`);
  }
  out.push('');
  for (const [key, title, hint] of SECTIONS) {
    out.push(`## ${title}`, '', hint, '', table(result[key], top));
  }
  return out.join('\n');
}

function extractRef(ref) {
  const directory = mkdtempSync(join(tmpdir(), 'refactor-finder-base-'));
  const paths = Object.values(AREAS)
    .flat()
    .filter((path) => {
      try {
        execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], {
          cwd: repoRoot,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    });
  const archive = execFileSync('git', ['archive', ref, ...paths], {
    cwd: repoRoot,
    maxBuffer: 512 * 1024 * 1024,
  });
  // Run inside the directory: GNU tar on Windows reads `C:\...` after `-C` as a remote host.
  execFileSync('tar', ['-x'], { cwd: directory, input: archive });
  return directory;
}

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const area = option('--area') ?? 'all';
const names = area === 'all' ? Object.keys(AREAS) : [area];
if (names.some((name) => !AREAS[name])) {
  console.error(`Unknown area "${area}". One of: ${Object.keys(AREAS).join(', ')}, all.`);
  process.exit(2);
}
const root = option('--root') ?? repoRoot;
const top = Number(option('--top') ?? 15);
const baseRef = option('--base-ref');

const result = scan(root, names);
let base;
if (baseRef) {
  const directory = extractRef(baseRef);
  try {
    base = scan(directory, names, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(
  process.argv.includes('--json')
    ? JSON.stringify({ area, baseRef, result, base }, null, 2)
    : render(area, result, base, baseRef, top),
);
