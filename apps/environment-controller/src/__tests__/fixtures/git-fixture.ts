import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ComposeRepository {
  /** The `file://` URL of the bare repository. */
  url: string;
  bare: string;
  /** The commit of the `dev` branch, which holds the files. */
  commit: string;
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
  if (result.status !== 0)
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare repository whose `dev` branch holds `files`; `main` is the default branch. */
export function createComposeRepository(
  root: string,
  name: string,
  files: Record<string, string>,
): ComposeRepository {
  const work = join(root, `${name}-work`);
  const bare = join(root, `${name}.git`);
  mkdirSync(work, { recursive: true });
  git(work, ['init', '--quiet', '--template=', '--initial-branch=main']);
  writeFileSync(join(work, 'README.md'), `# ${name}\n`);
  git(work, ['add', '--all']);
  git(work, ['commit', '--quiet', '-m', 'initial']);
  git(work, ['checkout', '--quiet', '-b', 'dev']);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, ['add', '--all']);
  git(work, ['commit', '--quiet', '-m', 'preview files']);
  const commit = git(work, ['rev-parse', 'HEAD']);
  git(root, ['clone', '--quiet', '--bare', '--template=', work, bare]);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { url: pathToFileURL(bare).href, bare, commit };
}
