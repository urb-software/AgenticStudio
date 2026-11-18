import type { RunPayload } from '@agentic-studio/contracts';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { runDirectories } from './run-layout.js';
import { type PreparedRun, readRunFile, STUDIO_EXCLUDE_SECTION } from './working-copy.js';

/**
 * Pathspecs of a Run's Studio-placed files: the claim payload's list always applies; what the agent
 * can write beside the Working copy (the Run file's paths, the patterns in Studio's section of
 * `.git/info/exclude`, as Git matches them) can only add to it. Never committed, never in diffs.
 */
export async function studioPathspecs(
  dataDir: string,
  prepared: PreparedRun,
  run: RunPayload,
): Promise<string[]> {
  const paths = runDirectories(dataDir, prepared.runId);
  const recorded = [...run.studioPaths, ...((await readRunFile(paths.runFile))?.studioPaths ?? [])]
    .map((path) => path.replace(/^\/+/, ''))
    .filter(isRelativePath)
    .map((path) => `:(literal)${path}`);
  const exclude = await readFile(
    posix.join(prepared.repoDir, '.git', 'info', 'exclude'),
    'utf8',
  ).catch(() => '');
  const lines = exclude.split('\n').map((line) => line.trim());
  const start = lines.indexOf(STUDIO_EXCLUDE_SECTION.trim());
  const listed = (start === -1 ? [] : lines.slice(start + 1))
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
    .map(excludePathspec)
    .filter((spec): spec is string => spec !== null);
  return [...new Set([...recorded, ...listed])];
}

/** A path inside the Working copy: relative, without `.` or `..` parts. */
function isRelativePath(path: string): boolean {
  return path !== '' && !path.split('/').some((part) => part === '..' || part === '.');
}

/** The pathspec matching what an exclude pattern matches (`null` for one that leaves the tree). */
function excludePathspec(pattern: string): string | null {
  const trimmed = pattern.replace(/\/+$/, '');
  const anchored = trimmed.includes('/');
  const path = trimmed.replace(/^\/+/, '');
  if (!isRelativePath(path)) return null;
  // A pathspec also matches everything below a directory it names.
  return `:(glob)${anchored ? path : `**/${path}`}`;
}
