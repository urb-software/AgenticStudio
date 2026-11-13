import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Bare fixture Repositories for the adapter's integration tests, built with the system
 * `git` in a temporary directory. The fixture Git runs isolated from the host's Git
 * configuration too, so the tests behave the same on every machine.
 */

export type FixtureFile = string | Buffer | { symlink: string } | { executable: string };

export interface Fixture {
  /** Path of the bare fixture Repository. */
  path: string;
  /** Its `file://` URL (allowed only when the test adds `file` to the transports). */
  url: string;
  /** Path of the working copy the fixture was committed from. */
  work: string;
}

function fixtureEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
}

export function fixtureGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: fixtureEnv(cwd), encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeFiles(work: string, files: Record<string, FixtureFile>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(work, name);
    mkdirSync(dirname(path), { recursive: true });
    if (typeof content === 'object' && 'symlink' in content) {
      symlinkSync(content.symlink, path);
    } else if (typeof content === 'object' && 'executable' in content) {
      writeFileSync(path, content.executable);
      chmodSync(path, 0o755);
    } else {
      writeFileSync(path, content);
    }
  }
}

/** Creates `<root>/<name>.git` with one commit of `files` on `branch`. */
export function createFixture(
  root: string,
  name: string,
  files: Record<string, FixtureFile>,
  options: { branch?: string; submodule?: { path: string; url: string; commit: string } } = {},
): Fixture {
  const branch = options.branch ?? 'main';
  const work = join(root, `${name}-work`);
  mkdirSync(work, { recursive: true });
  fixtureGit(work, ['init', '--quiet', '--template=', `--initial-branch=${branch}`]);
  writeFiles(work, files);
  fixtureGit(work, ['add', '--all']);
  if (options.submodule) {
    const { path, url, commit } = options.submodule;
    writeFileSync(
      join(work, '.gitmodules'),
      `[submodule "${path}"]\n\tpath = ${path}\n\turl = ${url}\n`,
    );
    fixtureGit(work, ['add', '.gitmodules']);
    fixtureGit(work, ['update-index', '--add', '--cacheinfo', `160000,${commit},${path}`]);
  }
  fixtureGit(work, ['commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const path = join(root, `${name}.git`);
  fixtureGit(root, ['clone', '--quiet', '--bare', '--template=', work, path]);
  return { path, url: pathToFileURL(path).href, work };
}

/** Adds a commit of `files` to the fixture and pushes it; returns the new commit id. */
export function addCommit(
  fixture: Fixture,
  files: Record<string, FixtureFile>,
  branch = 'main',
): string {
  writeFiles(fixture.work, files);
  fixtureGit(fixture.work, ['add', '--all']);
  fixtureGit(fixture.work, ['commit', '--quiet', '--allow-empty', '-m', 'next']);
  fixtureGit(fixture.work, ['push', '--quiet', fixture.path, `HEAD:refs/heads/${branch}`]);
  return fixtureGit(fixture.work, ['rev-parse', 'HEAD']);
}

export function headOf(fixture: Fixture, branch = 'main'): string {
  return fixtureGit(fixture.path, ['rev-parse', `refs/heads/${branch}`]);
}
