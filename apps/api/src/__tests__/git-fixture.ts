import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Bare fixture Repositories for the HTTP tests, built with the system `git` (Linux only, like
 * every repository feature). The fixture Git runs isolated from the host's configuration.
 */
export interface GitFixture {
  /** The `file://` URL, accepted only with the test-only fixture-remote setting. */
  url: string;
  /** Commit id of each branch at creation. */
  commits: Record<string, string>;
  /** The bare repository's directory. */
  bare: string;
  /** The working copy the fixture was built from (pushes to `bare`). */
  work: string;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Creates `<root>/<name>.git` whose HEAD (default branch) is `main`, with one commit on each
 * of `branches` (default `main` and `dev`). `bigFileBytes` adds an incompressible file.
 */
export function createGitFixture(
  root: string,
  name: string,
  options: { branches?: string[]; bigFileBytes?: number } = {},
): GitFixture {
  const branches = options.branches ?? ['main', 'dev'];
  const work = join(root, `${name}-work`);
  const bare = join(root, `${name}.git`);
  mkdirSync(work, { recursive: true });
  git(work, ['init', '--quiet', '--template=', '--initial-branch=main']);
  writeFileSync(join(work, 'README.md'), `# ${name}\n`);
  if (options.bigFileBytes) {
    writeFileSync(join(work, 'blob.bin'), randomBytes(options.bigFileBytes));
  }
  git(work, ['add', '--all']);
  git(work, ['commit', '--quiet', '-m', 'initial']);
  const commits: Record<string, string> = {};
  for (const branch of branches) {
    if (branch !== 'main') {
      git(work, ['checkout', '--quiet', '-b', branch, 'main']);
      writeFileSync(join(work, `${branch}.txt`), `${branch}\n`);
      git(work, ['add', '--all']);
      git(work, ['commit', '--quiet', '-m', `on ${branch}`]);
    }
    commits[branch] = git(work, ['rev-parse', 'HEAD']);
  }
  git(root, ['clone', '--quiet', '--bare', '--template=', work, bare]);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { url: pathToFileURL(bare).href, commits, bare, work };
}

/**
 * Pushes a new commit on `branch` to the fixture's bare repository (as another client would);
 * returns its id. `bigFileBytes` adds an incompressible file to the commit.
 */
export function pushCommit(
  fixture: GitFixture,
  branch: string,
  options: { bigFileBytes?: number } = {},
): string {
  git(fixture.work, ['checkout', '--quiet', branch]);
  const name = `change-${randomBytes(4).toString('hex')}`;
  writeFileSync(join(fixture.work, `${name}.txt`), `${name}\n`);
  if (options.bigFileBytes) {
    writeFileSync(join(fixture.work, `${name}.bin`), randomBytes(options.bigFileBytes));
  }
  git(fixture.work, ['add', '--all']);
  git(fixture.work, ['commit', '--quiet', '-m', name]);
  git(fixture.work, ['push', '--quiet', fixture.bare, `${branch}:${branch}`]);
  return git(fixture.work, ['rev-parse', 'HEAD']);
}

/** Deletes `branch` from the fixture's bare repository. */
export function deleteRemoteBranch(fixture: GitFixture, branch: string): void {
  git(fixture.bare, ['update-ref', '-d', `refs/heads/${branch}`]);
}

/** Puts `branch` back on the fixture's bare repository at the working copy's commit. */
export function restoreRemoteBranch(fixture: GitFixture, branch: string): void {
  git(fixture.work, ['push', '--quiet', fixture.bare, `${branch}:${branch}`]);
}
