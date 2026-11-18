// `pnpm run structure:report`: numbers that show structural drift in the API (Issue #170,
// docs/engineering/quality.md §8). Not a check: it always exits 0 and a pull request is never
// blocked by it. It prints a Markdown report of apps/api/src:
//
//   - the largest source files (lines),
//   - every file under a module's `domain/` over 400 lines (rule 13: size is reported, not enforced),
//   - the number of methods per repository interface,
//   - the number of public methods per handler,
//   - the number of collaborators per module (files directly in `application/`),
//   - the number of files per feature (`application/features/<feature>/`, tests included),
//   - the comment-to-code ratio per production file across the API, the agent worker and the shared
//     packages, with the files above 0.25 flagged (rule 14).
//
// With `--base-ref <git ref>` it also reads the same tree at that ref and shows, beside each number,
// the change against it ("new" when the base has no such file, interface, handler or feature; for
// the comment ratio, the change in the number of flagged files). CI passes the pull request's base
// commit and appends the output to the job summary.
//
//   node scripts/structure-report.mjs [--source <apps/api dir>] [--base-ref <git ref>] [--top <n>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { countLines, listSourceFiles } from './comment-rules.mjs';

const repoRoot = join(import.meta.dirname, '..');

/** Rule 13 of backend.md §3: a file under a module's `domain/` over this many lines is flagged. */
const DOMAIN_LINE_LIMIT = 400;

/** Rule 14: a file whose comment lines are above this share of its code lines is flagged. */
export const COMMENT_RATIO_LIMIT = 0.25;

/** How many files of the comment ratio table are shown. */
const COMMENT_TABLE_ROWS = 30;

/** Test code for the comment ratio: `__tests__/`, `*.test.*`, `*.spec.*` and `tests/`. */
const isTest = (path) =>
  /(^|\/)__tests__\//.test(path) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
  path.startsWith('tests/');

/** Production TypeScript under `src/`: no tests and no declaration files. */
const isProduction = (path) =>
  /\.tsx?$/.test(path) &&
  !path.endsWith('.d.ts') &&
  !/(^|\/)__tests__\//.test(path) &&
  !/\.(test|spec)\.tsx?$/.test(path);

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

const parse = (dir, path) =>
  ts.createSourceFile(path, readFileSync(join(dir, path), 'utf8'), ts.ScriptTarget.Latest);

/**
 * The comment-to-code ratio of every production file under `root` (the repository root) that the
 * comment checks cover: tests (`__tests__/`, `*.test.*`) and `tests/architecture` are test code.
 * Counting follows scripts/comment-rules.mjs, so the report and the checks agree.
 */
export function measureComments(root) {
  const files = {};
  for (const path of listSourceFiles(root)) {
    if (isTest(path)) continue;
    const counted = countLines(readFileSync(join(root, path), 'utf8'), path);
    if (counted && counted.code > 0) {
      files[path] = { ...counted, ratio: counted.comment / counted.code };
    }
  }
  return files;
}

const flagged = (files) =>
  Object.entries(files).filter(([, file]) => file.ratio > COMMENT_RATIO_LIMIT);

function commentSection(current, base, top = COMMENT_TABLE_ROWS) {
  const rows = flagged(current).sort((a, b) => b[1].ratio - a[1].ratio || a[0].localeCompare(b[0]));
  const change = base ? delta(rows.length, flagged(base).length) : '';
  const lines = [
    `### Comment-to-code ratio (rule 14: above ${COMMENT_RATIO_LIMIT} is flagged; reported, not enforced)`,
    '',
    `Flagged files: ${rows.length} of ${Object.keys(current).length}${change}.`,
    '',
    '| File | Ratio | Comment lines | Code lines |',
    '| --- | ---: | ---: | ---: |',
  ];
  if (rows.length === 0) lines.push('| (none) | 0 | 0 | 0 |');
  for (const [name, file] of rows.slice(0, top)) {
    lines.push(`| \`${name}\` | ${file.ratio.toFixed(2)} | ${file.comment} | ${file.code} |`);
  }
  if (rows.length > top) lines.push('', `Top ${top} of ${rows.length}.`);
  return lines.join('\n');
}

/** The measurements of the API source tree at `apiDir` (a directory holding `src/`). */
export function measure(apiDir) {
  const files = listFiles(join(apiDir, 'src')).map((path) => `src/${path}`);
  const production = files.filter(isProduction);

  const sizes = {};
  for (const path of production) {
    const text = readFileSync(join(apiDir, path), 'utf8');
    sizes[path] = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  const domainOverLimit = {};
  for (const [path, lines] of Object.entries(sizes)) {
    if (/^src\/modules\/[^/]+\/domain\//.test(path) && lines > DOMAIN_LINE_LIMIT) {
      domainOverLimit[path] = lines;
    }
  }

  const repositoryMethods = {};
  const handlerMethods = {};
  for (const path of production) {
    const repository = /^src\/modules\/([^/]+)\/domain\/repositories\//.exec(path);
    const handler = /^src\/modules\/([^/]+)\/application\/features\/[^/]+\/handler\.ts$/.exec(path);
    if (!repository && !handler) continue;
    const source = parse(apiDir, path);
    for (const statement of source.statements) {
      if (
        repository &&
        (ts.isInterfaceDeclaration(statement) ||
          (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type))) &&
        /Repository$/.test(statement.name.text)
      ) {
        const members = ts.isInterfaceDeclaration(statement)
          ? statement.members
          : statement.type.members;
        repositoryMethods[`${repository[1]}/${statement.name.text}`] = new Set(
          members.flatMap((member) => {
            const method =
              ts.isMethodSignature(member) ||
              (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type));
            return method &&
              member.name &&
              (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
              ? [member.name.text]
              : [];
          }),
        ).size;
      }
      if (handler && ts.isClassDeclaration(statement)) {
        const count = statement.members.filter((member) => {
          if (!ts.isMethodDeclaration(member) && !ts.isGetAccessor(member)) return false;
          const modifiers = ts.getModifiers(member) ?? [];
          return !modifiers.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.PrivateKeyword ||
              modifier.kind === ts.SyntaxKind.ProtectedKeyword,
          );
        }).length;
        handlerMethods[path.replace(/^src\/modules\//, '').replace(/\/handler\.ts$/, '')] = count;
      }
    }
  }

  const modules = [
    ...new Set(files.map((path) => /^src\/modules\/([^/]+)\//.exec(path)?.[1]).filter(Boolean)),
  ].sort();
  const collaborators = Object.fromEntries(
    modules.map((module) => [
      module,
      production.filter((path) =>
        new RegExp(`^src/modules/${module}/application/[^/]+\\.tsx?$`).test(path),
      ).length,
    ]),
  );

  const featureFiles = {};
  for (const path of files) {
    const feature = /^src\/modules\/([^/]+\/application\/features\/[^/]+)\//.exec(path);
    if (feature) {
      const key = feature[1].replace('/application/features/', '/');
      featureFiles[key] = (featureFiles[key] ?? 0) + 1;
    }
  }

  return { sizes, domainOverLimit, repositoryMethods, handlerMethods, collaborators, featureFiles };
}

const delta = (now, before) => {
  if (before === undefined) return ' (new)';
  const change = now - before;
  return change === 0 ? '' : ` (${change > 0 ? '+' : ''}${change})`;
};

function table(title, unit, now, base, { top, keepAll = false, quiet = false } = {}) {
  const rows = Object.entries(now).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = keepAll ? rows : rows.slice(0, top);
  const lines = [`### ${title}`, '', `| Item | ${unit} |`, '| --- | ---: |'];
  if (shown.length === 0) lines.push('| (none) | 0 |');
  for (const [name, value] of shown) {
    lines.push(`| \`${name}\` | ${value}${base ? delta(value, base[name]) : ''} |`);
  }
  if (!keepAll && rows.length > shown.length) {
    lines.push('', `Top ${shown.length} of ${rows.length}.`);
  }
  if (base) {
    const gone = Object.keys(base).filter((name) => !(name in now));
    if (gone.length > 0 && keepAll && !quiet)
      lines.push('', `Not in this tree any more: ${gone.map((n) => `\`${n}\``).join(', ')}.`);
  }
  return lines.join('\n');
}

export function report(current, base, top = 10) {
  const out = ['## API structure report', ''];
  out.push(
    base
      ? 'Change against the base branch in parentheses. A report only: it never fails the build.'
      : 'No comparison with the base branch (none given, or it could not be read). A report only: it never fails the build.',
    '',
  );
  out.push(
    table('Largest source files', 'lines', current.sizes, base?.sizes, { top }),
    '',
    table(
      `Files under a module's \`domain/\` over ${DOMAIN_LINE_LIMIT} lines (rule 13: reported, not enforced)`,
      'lines',
      current.domainOverLimit,
      // The change is against the file's size at the base, so a file that existed and just
      // crossed the limit shows its growth, not "(new)".
      base?.sizes,
      { keepAll: true, quiet: true },
    ),
    '',
    table(
      'Methods per repository interface',
      'methods',
      current.repositoryMethods,
      base?.repositoryMethods,
      { keepAll: true },
    ),
    '',
    table('Public methods per handler', 'methods', current.handlerMethods, base?.handlerMethods, {
      top,
    }),
    '',
    table(
      'Collaborators per module (files directly in `application/`)',
      'files',
      current.collaborators,
      base?.collaborators,
      { keepAll: true },
    ),
    '',
    table('Files per feature (tests included)', 'files', current.featureFiles, base?.featureFiles, {
      top,
    }),
    '',
  );
  if (current.comments) out.push(commentSection(current.comments, base?.comments), '');
  return out.join('\n');
}

/** What the comparison reads from the base: the API source and the other trees of the comment ratio. */
const BASE_PATHS = ['apps/api/src', 'apps/agent-worker', 'packages', 'tests/architecture'];

/** The trees as they were at `ref`, extracted to a temporary directory (undefined if it cannot be). */
function extractBase(ref) {
  const directory = mkdtempSync(join(tmpdir(), 'structure-report-base-'));
  try {
    const archive = execFileSync('git', ['archive', ref, ...BASE_PATHS], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', directory], { input: archive });
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    console.error(`structure-report: no comparison, cannot read ${ref}: ${error.message}`);
    return undefined;
  }
}

function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const source = option('--source') ?? join(repoRoot, 'apps', 'api');
  const top = Number(option('--top') ?? 10);
  const baseRef = option('--base-ref');
  const current = measure(source);
  current.comments = measureComments(repoRoot);
  let base;
  if (baseRef) {
    const directory = extractBase(baseRef);
    if (directory) {
      try {
        base = measure(join(directory, 'apps', 'api'));
        base.comments = measureComments(directory);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  console.log(report(current, base, Number.isFinite(top) && top > 0 ? top : 10));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // A report never fails the build.
    console.log(`## API structure report\n\nThe report could not be produced: ${error.message}\n`);
  }
  process.exitCode = 0;
}
