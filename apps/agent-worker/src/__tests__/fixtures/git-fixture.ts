import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Issue #98: fixture repositories for the worker's Working copy tests: a bare "remote" reached
// through a file:// URL, filled from a scratch clone. No network; Linux only, like the worker.

/** A Git environment of its own: no system or user configuration of the machine running the tests. */
export function isolatedGitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
}

export function git(cwd: string, args: string[], env: Record<string, string>): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

export interface FixtureRemote {
  /** The remote's file:// URL, as a Repository's remote URL. */
  url: string;
  /** Commits files (and symlinks) on `main` and pushes; returns the commit id. */
  commit(message: string, files: Record<string, string>, symlinks?: Record<string, string>): string;
  /** Moves `main` back to `commit` on the remote (a force-push). */
  forcePush(commit: string): void;
}

/** A bare remote under `root` with one branch, `main`. */
export function createRemote(
  root: string,
  name: string,
  env: Record<string, string>,
): FixtureRemote {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  mkdirSync(bare, { recursive: true });
  git(bare, ['init', '--quiet', '--bare', '--initial-branch=main'], env);
  mkdirSync(work, { recursive: true });
  git(work, ['init', '--quiet', '--initial-branch=main'], env);
  git(work, ['remote', 'add', 'origin', bare], env);
  return {
    url: `file://${bare}`,
    commit(message, files, symlinks = {}) {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), content);
      }
      for (const [path, target] of Object.entries(symlinks)) {
        symlinkSync(target, join(work, path));
      }
      git(work, ['add', '--all'], env);
      git(work, ['commit', '--quiet', '-m', message], env);
      git(work, ['push', '--quiet', '--force', 'origin', 'HEAD:main'], env);
      return git(work, ['rev-parse', 'HEAD'], env);
    },
    forcePush(commit) {
      git(work, ['reset', '--quiet', '--hard', commit], env);
      git(work, ['push', '--quiet', '--force', 'origin', 'HEAD:main'], env);
      // The remote drops the unreachable commits, as a hosting service eventually does.
      git(bare, ['reflog', 'expire', '--expire=now', '--all'], env);
      git(bare, ['gc', '--quiet', '--prune=now'], env);
    },
  };
}
