// Rule 14 of docs/engineering/quality.md §5, as code: the two blocking comment checks and the
// comment counts of the structure report share this one definition of a comment and of a block.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/** Comment blocks longer than this many lines need `@long-comment <reason>`. */
export const MAX_COMMENT_LINES = 3;

/** Source roots under the repository root; `apps/web` is out until its own clean-up. */
const ROOTS = ['apps/api/src', 'apps/agent-worker', 'packages', 'tests/architecture'];
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'generated']);
const GENERATED_HEADER = /@generated|auto-?generated|do not edit/i;

/** Tool directives are not comments for rule 14. */
const DIRECTIVE =
  /^\s*(?:eslint-(?:disable|enable)|@ts-expect-error|@ts-ignore|@ts-nocheck|prettier-ignore|\/\s*<reference)/;

const ISSUE_REFERENCE = /(?<![\w&])#\d+(?!\w)|github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+/i;
const LONG_COMMENT_TAG = /@long-comment(?<reason>[^\n]*)/;

/** Whether `path` (relative, forward slashes) is covered by the comment checks. */
export function inScope(path) {
  if (!SOURCE.test(path) || path.endsWith('.d.ts') || path.endsWith('.d.mts')) return false;
  if (path.split('/').some((segment) => SKIPPED_DIRECTORIES.has(segment))) return false;
  if (path.startsWith('tests/architecture/fixtures/')) return false;
  return ROOTS.some((root) => path.startsWith(`${root}/`));
}

/** Every covered source file under `root`, relative with forward slashes, sorted. */
export function listSourceFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        found.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  for (const top of ROOTS) if (existsSync(join(root, top))) walk(join(root, top));
  return found.filter(inScope).sort();
}

function leafTokens(node, source, out) {
  const children = node.getChildren(source);
  if (children.length === 0) {
    out.push(node);
    return;
  }
  for (const child of children) {
    if (child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode) {
      continue;
    }
    leafTokens(child, source, out);
  }
}

/**
 * The comments of one file, found by the TypeScript scanner (never by a pattern over code), as
 * blocks: one block comment, or a run of own-line `//` comments. `lines` counts text lines only:
 * blank lines and a lone comment opener or closer do not count. A trailing comment on a code
 * line is a block of its own. Also the number of lines that hold code.
 */
export function analyse(text, fileName = 'file.ts') {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (position) => source.getLineAndCharacterOfPosition(position).line;
  const tokens = [];
  leafTokens(source, source, tokens);

  const codeLines = new Set();
  const ranges = new Map();
  for (const token of tokens) {
    if (token.kind !== ts.SyntaxKind.EndOfFileToken) {
      for (let line = lineOf(token.getStart(source)); line <= lineOf(token.end - 1); line += 1) {
        codeLines.add(line);
      }
    }
    for (const range of ts.getLeadingCommentRanges(text, token.getFullStart()) ?? []) {
      ranges.set(range.pos, range);
    }
  }

  const blocks = [];
  let run;
  const closeRun = () => {
    if (run) blocks.push(run);
    run = undefined;
  };
  for (const range of [...ranges.values()].sort((a, b) => a.pos - b.pos)) {
    const startLine = lineOf(range.pos);
    const raw = text.slice(range.pos, range.end);
    const trailing = codeLines.has(startLine);
    const single = range.kind === ts.SyntaxKind.SingleLineCommentTrivia;
    const body = single
      ? [raw.replace(/^\/\//, '')]
      : raw
          .replace(/^\/\*+/, '')
          .replace(/\*+\/$/, '')
          .split('\n')
          .map((line) => line.replace(/^\s*\*+/, ''));
    const texts = body.map((line) => line.trim());
    const directive = DIRECTIVE.test(texts.find((line) => line !== '') ?? '');
    const lines = directive ? 0 : texts.filter((line) => line !== '').length;
    const block = {
      startLine: startLine + 1,
      endLine: lineOf(range.end) + 1,
      lines,
      texts,
      trailing,
    };
    if (single && !trailing) {
      if (run && run.endLine === block.startLine - 1) {
        run.endLine = block.endLine;
        run.lines += lines;
        run.texts.push(...texts);
      } else {
        closeRun();
        run = block;
      }
    } else {
      closeRun();
      blocks.push(block);
    }
  }
  closeRun();
  return { blocks, codeLines: codeLines.size };
}

/** The violations of both checks in one file: `{ rule, line, message }`. */
export function checkText(text, fileName = 'file.ts') {
  const violations = [];
  for (const block of analyse(text, fileName).blocks) {
    const joined = block.texts.join('\n');
    if (ISSUE_REFERENCE.test(joined)) {
      violations.push({
        rule: 'comment-no-issue-reference',
        line: block.startLine,
        message: 'a comment names an Issue or pull request (`#<digits>` or a link)',
      });
    }
    const tag = LONG_COMMENT_TAG.exec(joined);
    const reason = tag?.groups.reason.replace(/\*+\/?\s*$/, '').trim();
    if (tag && !reason) {
      violations.push({
        rule: 'comment-long-needs-reason',
        line: block.startLine,
        message: '`@long-comment` needs a reason after the tag',
      });
    } else if (!tag && block.lines > MAX_COMMENT_LINES) {
      violations.push({
        rule: 'comment-max-lines',
        line: block.startLine,
        message: `a comment of ${block.lines} lines (limit ${MAX_COMMENT_LINES}); shorten it or tag it \`@long-comment <reason>\``,
      });
    }
  }
  return violations;
}

/** The violations of both checks over the covered files under `root`: `{ rule, file, line, message }`. */
export function checkTree(root) {
  return listSourceFiles(root).flatMap((file) =>
    checkText(readFileSync(join(root, file), 'utf8'), file).map((violation) => ({
      ...violation,
      file,
    })),
  );
}

/** Comment lines and code lines of one file, for the structure report; undefined for a generated file. */
export function countLines(text, fileName = 'file.ts') {
  if (GENERATED_HEADER.test(text.slice(0, 300))) return undefined;
  const { blocks, codeLines } = analyse(text, fileName);
  return { comment: blocks.reduce((sum, block) => sum + block.lines, 0), code: codeLines };
}

/** Every `@long-comment` in the covered files under `root`: `{ file, line, reason }`. */
export function longComments(root) {
  return listSourceFiles(root).flatMap((file) =>
    analyse(readFileSync(join(root, file), 'utf8'), file).blocks.flatMap((block) => {
      const tag = LONG_COMMENT_TAG.exec(block.texts.join('\n'));
      return tag ? [{ file, line: block.startLine, reason: tag.groups.reason.trim() }] : [];
    }),
  );
}
