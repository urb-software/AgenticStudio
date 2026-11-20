// Repository guards over tracked files: the design-system copy and merge-conflict markers.
// Run: `pnpm guards:check`. Reads only `git ls-files`, so untracked and ignored files never count.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESIGN_SYSTEM_COPY = 'apps/web/src/app/globals.css';
export const DESIGN_SYSTEM_SOURCE = 'design-system/code/globals.css';

const BINARY_PROBE_BYTES = 8 * 1024;
const MARKER = /^(?:<<<<<<<|>>>>>>>)(?: |$)/;
const SEPARATOR = /^=======$/;

/** An error message per problem: the copy differs from its source. */
export function checkDesignSystemCopy(read) {
  const copy = read(DESIGN_SYSTEM_COPY);
  const source = read(DESIGN_SYSTEM_SOURCE);
  if (copy && source && copy.equals(source)) return [];
  return [
    `${DESIGN_SYSTEM_COPY} must be byte-identical to ${DESIGN_SYSTEM_SOURCE}. ` +
      `Restore it with: cp ${DESIGN_SYSTEM_SOURCE} ${DESIGN_SYSTEM_COPY} ` +
      '(never run Prettier on it).',
  ];
}

/** `file:line` of every conflict marker; a `=======` line counts only in a file with a marker. */
export function conflictMarkers(file, content) {
  if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) return [];
  const lines = content.toString('utf8').split(/\r?\n/);
  const found = [];
  let hasMarker = false;
  lines.forEach((line, index) => {
    if (MARKER.test(line)) {
      hasMarker = true;
      found.push(index + 1);
    } else if (SEPARATOR.test(line)) {
      found.push(index + 1);
    }
  });
  if (!hasMarker) return [];
  return found.map((line) => `${file}:${line}`);
}

/** Every problem in the tracked `files` under `root`, as messages. */
export function checkRepository(root, files) {
  const read = (path) => {
    try {
      return readFileSync(join(root, path));
    } catch {
      return null;
    }
  };
  const problems = checkDesignSystemCopy(read);
  for (const file of files) {
    const content = read(file);
    if (!content) continue;
    for (const location of conflictMarkers(file, content)) {
      problems.push(`${location}: merge conflict marker`);
    }
  }
  return problems;
}

function trackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, '..');
  const problems = checkRepository(root, trackedFiles(root));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log('Repository guards passed.');
}
