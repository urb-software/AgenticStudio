import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  utimesSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCommandError, GitRunner, type GitOptions } from '../git.js';
import { git as plainGit, isolatedGitEnv } from './fixtures/git-fixture.js';

// Programs named by a Working copy's configuration, an included file or the agent user's global
// configuration must never run, and Git gets none of the worker's secrets. Real Git; every
// hostile program would touch the marker file.

const PLACES = ['repository config', 'include.path', 'global config'] as const;
type Place = (typeof PLACES)[number];

describe.skipIf(process.platform !== 'linux')('the worker Git isolation', () => {
  let root: string;
  let repo: string;
  let home: string;
  let marker: string;
  let env: Record<string, string>;
  let runner: GitRunner;
  // Obviously fake values, made at run time.
  const fake = () => `fake-${randomBytes(9).toString('hex')}`;
  const secrets = {
    STUDIO_WORKER_TOKEN: fake(),
    STUDIO_AGENT_GITHUB_TOKEN: fake(),
    ANTHROPIC_API_KEY: fake(),
  };

  const options = (overrides: Partial<GitOptions> = {}): GitOptions => ({
    cwd: repo,
    timeoutMs: 60_000,
    ceiling: root,
    ...overrides,
  });
  const run = (args: string[], overrides: Partial<GitOptions> = {}) =>
    runner.run(args, options(overrides));
  const plain = (args: string[]) => plainGit(repo, args, env);

  /** Sets one configuration value where `place` says; plain Git, before any hostile setting. */
  function configure(place: Place, key: string, value: string) {
    if (place === 'repository config') {
      plain(['config', '--local', key, value]);
    } else if (place === 'include.path') {
      const included = join(root, 'included.cfg');
      plainGit(root, ['config', '--file', included, key, value], env);
      plain(['config', '--local', '--replace-all', 'include.path', included]);
    } else {
      plainGit(root, ['config', '--file', join(home, '.gitconfig'), key, value], env);
    }
  }

  /** An executable script that touches the marker. */
  function script(name: string, body: string): string {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'studio-isolation-')).replaceAll('\\', '/');
    repo = join(root, 'repo');
    home = join(root, 'home');
    marker = join(root, 'MARKER');
    mkdirSync(repo);
    mkdirSync(home);
    env = isolatedGitEnv(home);
    runner = new GitRunner({
      env: { PATH: env.PATH, HOME: home, ...secrets, SSH_AUTH_SOCK: '/run/fake-agent.sock' },
    });
    // c1 on main; side changes the last line of f; main then changes a.txt and the first line of f.
    plain(['init', '--quiet', '--initial-branch=main']);
    plain(['config', '--local', 'user.name', 'Fixture']);
    plain(['config', '--local', 'user.email', 'fixture@example.test']);
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=evil diff=evil\nf merge=evil\n');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'f'), 'a\nb\nc\nd\ne\n');
    plain(['add', '--all']);
    plain(['commit', '--quiet', '-m', 'c1']);
    plain(['checkout', '--quiet', '-b', 'side']);
    writeFileSync(join(repo, 'f'), 'a\nb\nc\nd\nE\n');
    plain(['commit', '--quiet', '-am', 'side']);
    plain(['checkout', '--quiet', 'main']);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'f'), 'A\nb\nc\nd\ne\n');
    plain(['commit', '--quiet', '-am', 'c2']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const neverRan = () => expect(existsSync(marker)).toBe(false);

  describe.each(PLACES)('named in the %s', (place) => {
    it('runs no clean filter on add --all', async () => {
      configure(place, 'filter.evil.clean', `touch '${marker}'; cat`);
      writeFileSync(join(repo, 'b.txt'), 'new\n');

      await run(['add', '--all']);

      neverRan();
      expect(plain(['ls-files'])).toContain('b.txt');
    });

    it('runs no smudge filter on checkout --force', async () => {
      configure(place, 'filter.evil.smudge', `touch '${marker}'; cat`);

      await run(['checkout', '--force', '--quiet', 'HEAD~1', '--', 'a.txt']);

      neverRan();
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
    });

    it('runs no process filter, even a required one', async () => {
      configure(place, 'filter.evil.process', `touch '${marker}'; cat`);
      configure(place, 'filter.evil.required', 'true');
      writeFileSync(join(repo, 'b.txt'), 'new\n');

      await run(['add', '--all']);

      neverRan();
      expect(plain(['ls-files'])).toContain('b.txt');
    });

    it('runs no fsmonitor', async () => {
      configure(place, 'core.fsmonitor', script('fsmonitor.sh', "printf '\\0'"));

      await run(['status', '--porcelain=v1']);

      neverRan();
    });

    it('runs no hook, whether in .git/hooks or named by core.hooksPath', async () => {
      const hooks = join(root, 'hooks');
      mkdirSync(hooks);
      for (const name of ['pre-commit', 'post-merge', 'post-checkout']) {
        const hook = script(`hook-${name}`, '');
        writeFileSync(join(hooks, name), readFileSync(hook));
        chmodSync(join(hooks, name), 0o755);
        mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
        writeFileSync(join(repo, '.git', 'hooks', name), readFileSync(hook));
        chmodSync(join(repo, '.git', 'hooks', name), 0o755);
      }
      rmSync(marker, { force: true });
      configure(place, 'core.hooksPath', hooks);
      writeFileSync(join(repo, 'b.txt'), 'new\n');
      await run(['add', '--all']);

      await run(['commit', '--quiet', '-m', 'with hooks']);
      await run(['checkout', '--quiet', 'side']);
      await run(['merge', '--quiet', '--no-edit', 'main']);

      neverRan();
    });

    it('runs no external diff, whether global or per driver', async () => {
      const external = script('external-diff.sh', 'exit 0');
      configure(place, 'diff.external', external);
      configure(place, 'diff.evil.command', external);

      await run(['diff', 'HEAD~1', 'HEAD']);

      neverRan();
    });

    it('runs no textconv', async () => {
      configure(place, 'diff.evil.textconv', `touch '${marker}'; cat`);

      const patch = await run(['diff', 'HEAD~1', 'HEAD', '--', 'a.txt']);

      neverRan();
      expect(patch).toContain('+two');
    });

    it('runs no merge driver and merges with Git own merge instead', async () => {
      configure(place, 'merge.evil.driver', script('merge-driver.sh', 'exit 1'));

      await run(['merge', '--quiet', '--no-edit', 'side']);

      neverRan();
      expect(readFileSync(join(repo, 'f'), 'utf8')).toBe('A\nb\nc\nd\nE\n');
      expect(plain(['rev-list', '--parents', '-1', 'HEAD']).split(' ')).toHaveLength(3);
    });

    it('stops at a conflict with conflict markers, without running the merge driver', async () => {
      configure(place, 'merge.evil.driver', script('merge-driver.sh', 'exit 1'));
      writeFileSync(join(repo, 'f'), 'a\nb\nc\nd\nX\n');
      plain(['commit', '--quiet', '-am', 'conflicting']);

      const failure = await run(['merge', '--quiet', '--no-edit', 'side']).catch(
        (error: unknown) => error,
      );

      neverRan();
      expect(failure).toBeInstanceOf(GitCommandError);
      expect((failure as GitCommandError).exitCode).toBe(1);
      const merged = readFileSync(join(repo, 'f'), 'utf8');
      expect(merged).toContain('<<<<<<<');
      expect(merged).toContain('X');
      expect(merged).toContain('E');
      expect(plain(['diff', '--name-only', '--diff-filter=U'])).toBe('f');
    });

    it('runs no signing program', async () => {
      configure(place, 'gpg.program', script('gpg.sh', 'exit 1'));
      configure(place, 'commit.gpgSign', 'true');
      writeFileSync(join(repo, 'b.txt'), 'new\n');
      await run(['add', '--all']);

      await run(['commit', '--quiet', '-m', 'signed?']).catch(() => undefined);

      neverRan();
    });

    it('runs no clean filter on rm --cached of a stat-dirty file', async () => {
      configure(place, 'filter.evil.clean', `touch '${marker}'; cat`);
      const later = new Date(Date.now() + 3_600_000);
      utimesSync(join(repo, 'a.txt'), later, later);

      await run(['rm', '--cached', '-r', '--ignore-unmatch', '--', 'a.txt']);

      neverRan();
      expect(plain(['ls-files'])).not.toContain('a.txt');
    });

    describe('a fetch from a local path', () => {
      let cache: string;
      const fetchFromCache = () =>
        run([
          'fetch',
          '--quiet',
          '--no-tags',
          '--',
          cache,
          '+refs/heads/main:refs/remotes/cache/main',
        ]);

      beforeEach(() => {
        cache = join(root, 'cache.git');
        plainGit(root, ['clone', '--quiet', '--bare', repo, cache], env);
      });

      it('runs no upload-pack program named for that path', async () => {
        configure(place, `remote.${cache}.uploadpack`, `touch '${marker}'; git-upload-pack`);

        await fetchFromCache();

        neverRan();
        expect(plain(['rev-parse', '--verify', 'refs/remotes/cache/main'])).toMatch(
          /^[0-9a-f]{40}$/,
        );
      });

      it('runs no alternate refs command', async () => {
        mkdirSync(join(repo, '.git', 'objects', 'info'), { recursive: true });
        writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${cache}/objects\n`);
        configure(place, 'core.alternateRefsCommand', `touch '${marker}'`);

        await fetchFromCache();

        neverRan();
      });
    });
  });

  describe('a nested repository with its own filter', () => {
    /** An embedded repository committed as a gitlink; its own config then names a clean filter. */
    function embedded() {
      const sub = join(repo, 'sub');
      mkdirSync(sub);
      plainGit(sub, ['init', '--quiet', '--initial-branch=main'], env);
      plainGit(sub, ['config', '--local', 'user.name', 'Fixture'], env);
      plainGit(sub, ['config', '--local', 'user.email', 'fixture@example.test'], env);
      writeFileSync(join(sub, 's.txt'), 'inner\n');
      plainGit(sub, ['add', '--all'], env);
      plainGit(sub, ['commit', '--quiet', '-m', 'inner'], env);
      writeFileSync(join(repo, 'b.txt'), 'new\n');
      plain(['add', 'b.txt', 'sub']);
      writeFileSync(join(sub, '.gitattributes'), '* filter=sm\n');
      plainGit(sub, ['config', '--local', 'filter.sm.clean', `touch '${marker}'; cat`], env);
      const later = new Date(Date.now() + 3_600_000);
      writeFileSync(join(sub, 's.txt'), 'INNER\n');
      utimesSync(join(sub, 's.txt'), later, later);
    }

    it.each([
      ['status', ['status', '--porcelain=v1', '-z', '--untracked-files=all']],
      ['diff', ['diff', '--name-only']],
      ['add --all', ['add', '--all']],
      ['commit', ['commit', '--quiet', '-m', 'with a nested repository']],
    ])('runs no filter of it through %s', async (_name, args) => {
      embedded();

      await run(args as string[]);

      neverRan();
    });
  });

  describe('the environment', () => {
    /** A clean filter, enabled for this one call by the caller, that dumps its environment. */
    const dumping = (dump: string): GitOptions['config'] => [
      ['filter.evil.clean', `env > '${dump}'; cat`],
    ];

    it('holds none of the worker secrets and only allowlisted names', async () => {
      const dump = join(root, 'ENVIRONMENT');
      writeFileSync(join(repo, 'b.txt'), 'new\n');

      await run(['add', '--all'], { config: dumping(dump) });

      const lines = readFileSync(dump, 'utf8').split('\n').filter(Boolean);
      const text = lines.join('\n');
      for (const [name, value] of Object.entries(secrets)) {
        expect(text).not.toContain(name);
        expect(text).not.toContain(value);
      }
      expect(text).not.toContain('SSH_AUTH_SOCK');
      const names = lines.map((line) => line.split('=')[0]!);
      const shell = ['PWD', 'OLDPWD', 'SHLVL', '_'];
      const allowed = ['PATH', 'HOME', 'TMPDIR', 'LC_ALL', 'SSH_ASKPASS_REQUIRE'];
      for (const name of names) {
        expect([...allowed, ...shell].includes(name) || name.startsWith('GIT_')).toBe(true);
      }
      expect(lines).toContain('GIT_PAGER=cat');
      expect(lines).toContain('GIT_EDITOR=true');
      expect(lines).toContain('GIT_SEQUENCE_EDITOR=true');
      expect(lines).toContain('GIT_ASKPASS=');
    });

    it('keeps the SSH agent and the proxies, and still no secret, for a remote command', async () => {
      const dump = join(root, 'REMOTE_ENVIRONMENT');
      const remoteRunner = new GitRunner({
        env: {
          PATH: env.PATH,
          HOME: home,
          ...secrets,
          SSH_AUTH_SOCK: '/run/fake-agent.sock',
          HTTPS_PROXY: 'http://proxy.test:3128',
        },
      });

      // The ssh program is the dump script; it fails, as there is no server.
      await remoteRunner
        .run(['ls-remote', 'ssh://git@host.test/acme/shop.git'], {
          ...options(),
          scope: 'remote',
          transports: ['ssh'],
          config: [['core.sshCommand', `env > '${dump}'; exit 1`]],
        })
        .catch(() => undefined);

      const text = readFileSync(dump, 'utf8');
      expect(text).toContain('SSH_AUTH_SOCK=/run/fake-agent.sock');
      expect(text).toContain('HTTPS_PROXY=http://proxy.test:3128');
      for (const [name, value] of Object.entries(secrets)) {
        expect(text).not.toContain(name);
        expect(text).not.toContain(value);
      }
    });

    it('still hands the push its token header, through the command configuration', async () => {
      const header = `Authorization: Basic ${fake()}`;

      const value = await run(['config', '--get', 'http.https://github.com/.extraHeader'], {
        scope: 'remote',
        config: [['http.https://github.com/.extraHeader', header]],
      });

      expect(value.trim()).toBe(header);
    });
  });

  describe('the global configuration', () => {
    it('is not read by a Working copy command, and is read by a cache command', async () => {
      plainGit(
        root,
        ['config', '--file', join(home, '.gitconfig'), 'user.nickname', 'global'],
        env,
      );

      const inWorkingCopy = await run(['config', '--get', 'user.nickname']).catch(
        (error: unknown) => error,
      );
      const inCache = await run(['config', '--get', 'user.nickname'], { scope: 'cache' });

      expect((inWorkingCopy as GitCommandError).exitCode).toBe(1);
      expect(inCache.trim()).toBe('global');
    });
  });
});
