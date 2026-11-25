import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitCloneMissingError,
  GitCommitMissingError,
  GitNothingToCommitError,
  GitProjectNotWritableError,
  GitRemoteMovedError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  GitWriteRefusedError,
  type PublishRequest,
} from '../../../../application/ports/repository-git.js';
import { SystemGitAdapter, type SystemGitSettings } from '../system-git-adapter.js';
import {
  addCommit,
  createFixture,
  fixtureGit,
  headOf,
  type Fixture,
} from './fixtures/fixture-repos.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const IDENTITY = { name: 'Studio Publisher', email: 'studio@example.test' };
const text = (value: string) => new TextEncoder().encode(value);

/**
 * Studio's first write to a Repository, against the real `git` and a bare fixture remote (`file`
 * added to the transports for these tests only). Linux only; CI must not skip them.
 */
describe.runIf(process.platform === 'linux')('SystemGitAdapter publishing a commit', () => {
  let root: string;
  let dataDir: string;
  let tempRoot: string;
  let fixtures: string;
  let logs: string[];
  let remote: Fixture;

  function adapter(overrides: Partial<SystemGitSettings> = {}): SystemGitAdapter {
    return new SystemGitAdapter({
      dataDir,
      allowedTransports: ['ssh', 'https', 'file'],
      cloneTimeoutMs: 60_000,
      fetchTimeoutMs: 60_000,
      maxCloneBytes: 50 * 1024 * 1024,
      maxProcessMemoryBytes: 2 * 1024 ** 3,
      tempRoot,
      log: (message) => logs.push(message),
      allowPrivateRemotes: true,
      definitionsProjectId: () => Promise.resolve(PROJECT_ID),
      ...overrides,
    });
  }

  const clonePath = (id = PROJECT_ID) => join(dataDir, 'clones', `${id}.git`);
  const cloneRefs = () =>
    fixtureGit(clonePath(), ['for-each-ref', '--format=%(refname) %(objectname)']);
  const remoteRefs = () =>
    fixtureGit(remote.path, ['for-each-ref', '--format=%(refname) %(objectname)']);

  function request(base: string, overrides: Partial<PublishRequest> = {}): PublishRequest {
    return {
      branch: 'dev',
      baseCommit: base,
      changes: [{ path: 'agents/helper/AGENT.md', content: text('# helper\n'), executable: false }],
      message: 'Publish the helper agent',
      identity: IDENTITY,
      ...overrides,
    };
  }

  async function cloned(git = adapter()): Promise<string> {
    return (await git.clone(PROJECT_ID, remote.url, 'dev')).commit;
  }

  const allOutput = (error: unknown) =>
    [
      error instanceof Error ? `${error.name} ${error.message} ${error.stack ?? ''}` : '',
      (error as { detail?: string }).detail ?? '',
      ...logs,
    ].join('\n');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-publish-test-'));
    dataDir = join(root, 'data');
    tempRoot = join(root, 'tmp');
    fixtures = join(root, 'fixtures');
    await Promise.all([mkdir(dataDir), mkdir(tempRoot), mkdir(fixtures)]);
    logs = [];
    remote = createFixture(
      fixtures,
      'defs',
      {
        'README.md': '# defs\n',
        'agents/old/AGENT.md': 'old\n',
        'agents/old/notes.md': 'notes\n',
        'agents/old/run.sh': { executable: '#!/bin/sh\n' },
      },
      { branch: 'dev' },
    );
  });

  afterEach(async () => {
    expect(await readdir(tempRoot)).toEqual([]);
    await chmod(remote.path, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('commits the changes on top of the base and pushes that one commit as a fast-forward', async () => {
    const git = adapter();
    const base = await cloned(git);

    const { commit } = await git.publishCommit(
      PROJECT_ID,
      remote.url,
      request(base, {
        message: 'Publish agents\n\nMore than a subject line.',
        changes: [
          { path: 'agents/helper/AGENT.md', content: text('# helper\n'), executable: false },
          { path: 'agents/helper/run.sh', content: text('#!/bin/sh\necho hi\n'), executable: true },
          { path: 'agents/old/AGENT.md', content: text('changed\n'), executable: false },
          { path: 'agents/old/notes.md', content: null, executable: false },
          { path: 'agents/old/run.sh', content: text('#!/bin/sh\necho kept\n'), executable: true },
        ],
      }),
    );

    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(headOf(remote, 'dev')).toBe(commit);
    expect(fixtureGit(remote.path, ['rev-parse', `${commit}^`])).toBe(base);
    expect(
      fixtureGit(remote.path, ['rev-list', '--parents', '-n', '1', commit]).split(' '),
    ).toHaveLength(2);
    expect(fixtureGit(remote.path, ['log', '-1', '--format=%an|%ae|%cn|%ce', commit])).toBe(
      'Studio Publisher|studio@example.test|Studio Publisher|studio@example.test',
    );
    expect(fixtureGit(remote.path, ['log', '-1', '--format=%B', commit])).toBe(
      'Publish agents\n\nMore than a subject line.',
    );
    const tree = fixtureGit(remote.path, ['ls-tree', '-r', commit])
      .split('\n')
      .map((line) => line.replace(/ blob [0-9a-f]+\t/, ' '));
    expect(tree).toEqual([
      '100644 README.md',
      '100644 agents/helper/AGENT.md',
      '100755 agents/helper/run.sh',
      '100644 agents/old/AGENT.md',
      '100755 agents/old/run.sh',
    ]);
    expect(fixtureGit(remote.path, ['show', `${commit}:agents/old/AGENT.md`])).toBe('changed');
    // The Clone follows: its branch is the pushed commit, and it reads the new tree.
    expect(headOf({ ...remote, path: clonePath() }, 'dev')).toBe(commit);
    expect(await git.readBranchCommit(PROJECT_ID, 'dev')).toEqual({ commit });
    // Only the branch moved on the remote.
    expect(remoteRefs()).toBe(`refs/heads/dev ${commit}`);
  });

  it('keeps bytes that are not text, and a file with no trailing newline, exactly', async () => {
    const git = adapter();
    const base = await cloned(git);
    const bytes = Uint8Array.from([0, 255, 254, 10, 13, 10, 0, 1]);

    const { commit } = await git.publishCommit(
      PROJECT_ID,
      remote.url,
      request(base, {
        changes: [
          { path: 'agents/helper/data.bin', content: bytes, executable: false },
          { path: 'agents/helper/crlf.txt', content: text('a\r\nb'), executable: false },
        ],
      }),
    );

    const shown = spawnSync('git', ['show', `${commit}:agents/helper/data.bin`], {
      cwd: remote.path,
    });
    expect([...shown.stdout]).toEqual([...bytes]);
    const crlf = spawnSync('git', ['show', `${commit}:agents/helper/crlf.txt`], {
      cwd: remote.path,
    });
    expect(crlf.stdout.toString('latin1')).toBe('a\r\nb');
  });

  it('never touches a working tree, and takes no filter, attribute or hook of the Clone', async () => {
    const git = adapter();
    const base = await cloned(git);
    const marker = join(root, 'hook-ran');
    // Hooks and a filter planted in the Clone: none may run.
    await mkdir(join(clonePath(), 'hooks'), { recursive: true });
    for (const hook of ['pre-push', 'reference-transaction', 'post-commit']) {
      await writeFile(join(clonePath(), 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`, {
        mode: 0o755,
      });
    }
    await mkdir(join(clonePath(), 'info'), { recursive: true });
    await writeFile(join(clonePath(), 'info', 'attributes'), '* filter=planted text eol=crlf\n');
    fixtureGit(clonePath(), ['config', 'filter.planted.clean', `touch '${marker}'; cat`]);

    const { commit } = await git.publishCommit(
      PROJECT_ID,
      remote.url,
      request(base, {
        changes: [{ path: 'agents/helper/AGENT.md', content: text('a\nb\n'), executable: false }],
      }),
    );

    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const stored = spawnSync('git', ['show', `${commit}:agents/helper/AGENT.md`], {
      cwd: remote.path,
    });
    expect(stored.stdout.toString()).toBe('a\nb\n');
    expect((await readdir(clonePath())).filter((name) => name === 'agents')).toEqual([]);
  });

  it('refuses any project that is not the definitions Project, in the adapter itself, before it writes', async () => {
    const base = await cloned();
    const before = cloneRefs();
    const remoteBefore = remoteRefs();

    for (const definitionsProjectId of [
      () => Promise.resolve(OTHER_PROJECT_ID),
      () => Promise.resolve(null),
    ]) {
      await expect(
        adapter({ definitionsProjectId }).publishCommit(PROJECT_ID, remote.url, request(base)),
      ).rejects.toBeInstanceOf(GitProjectNotWritableError);
    }
    // Without the setting the adapter cannot tell, so it writes nowhere.
    await expect(
      adapter({ definitionsProjectId: undefined }).publishCommit(
        PROJECT_ID,
        remote.url,
        request(base),
      ),
    ).rejects.toBeInstanceOf(GitProjectNotWritableError);

    expect(cloneRefs()).toBe(before);
    expect(remoteRefs()).toBe(remoteBefore);
  });

  it('answers that the remote moved when it holds a commit the Clone lacks, and changes nothing', async () => {
    const git = adapter();
    const base = await cloned(git);
    const moved = addCommit(remote, { 'other.txt': 'someone else\n' }, 'dev');
    const before = cloneRefs();

    await expect(git.publishCommit(PROJECT_ID, remote.url, request(base))).rejects.toBeInstanceOf(
      GitRemoteMovedError,
    );

    expect(cloneRefs()).toBe(before);
    expect(headOf(remote, 'dev')).toBe(moved);
    expect(remoteRefs()).toBe(`refs/heads/dev ${moved}`);
  });

  it('answers that the remote moved when the Clone itself is past the base', async () => {
    const git = adapter();
    const base = await cloned(git);
    const moved = addCommit(remote, { 'other.txt': 'someone else\n' }, 'dev');
    await git.fetch(PROJECT_ID, remote.url, 'dev');

    await expect(git.publishCommit(PROJECT_ID, remote.url, request(base))).rejects.toBeInstanceOf(
      GitRemoteMovedError,
    );
    expect(headOf(remote, 'dev')).toBe(moved);
  });

  it('answers a commit the Clone lacks, a missing Clone and a platform it cannot run on', async () => {
    const git = adapter();
    await expect(
      git.publishCommit(PROJECT_ID, remote.url, request('a'.repeat(40))),
    ).rejects.toBeInstanceOf(GitCloneMissingError);
    await cloned(git);
    await expect(
      git.publishCommit(PROJECT_ID, remote.url, request('a'.repeat(40))),
    ).rejects.toBeInstanceOf(GitCommitMissingError);
    await expect(
      adapter({ platform: 'darwin' }).publishCommit(
        PROJECT_ID,
        remote.url,
        request('a'.repeat(40)),
      ),
    ).rejects.toBeInstanceOf(GitUnsupportedPlatformError);
  });

  it('answers write_refused when the remote refuses the ref, leaving the Clone and the remote as they were', async () => {
    const git = adapter();
    const base = await cloned(git);
    // The remote's own rule (a hidden ref is refused on push): the same answer a read-only key gets.
    fixtureGit(remote.path, ['config', 'receive.hideRefs', 'refs/heads/dev']);
    const before = cloneRefs();
    const remoteBefore = remoteRefs();

    const error = await git.publishCommit(PROJECT_ID, remote.url, request(base)).then(
      () => {
        throw new Error('expected a refusal');
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GitWriteRefusedError);
    expect(cloneRefs()).toBe(before);
    expect(remoteRefs()).toBe(remoteBefore);
    // Nothing the remote said reaches the error or the log.
    expect(allOutput(error)).not.toMatch(/hidden|rejected|remote:|deny/i);
    expect((error as GitWriteRefusedError).detail).toBe('');
  });

  it('refuses a read-only remote directory the same way', async () => {
    const git = adapter();
    const base = await cloned(git);
    spawnSync('chmod', ['-R', 'a-w', remote.path]);
    const writable =
      spawnSync('sh', ['-c', `test -w '${join(remote.path, 'objects')}'`]).status === 0;
    const before = cloneRefs();

    if (!writable) {
      await expect(git.publishCommit(PROJECT_ID, remote.url, request(base))).rejects.toBeInstanceOf(
        GitWriteRefusedError,
      );
      expect(cloneRefs()).toBe(before);
    }
    // A user who can write anyway (root) cannot be refused by a mode: nothing more to check.
  });

  it('never forces: no force flag and no plus in the refspec, with hooks and helpers off', async () => {
    const record = join(root, 'record');
    await mkdir(record);
    const wrapper = join(root, 'recording-git');
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\0' "$@" >> '${record}/args'\nprintf '\\n' >> '${record}/args'\nexec git "$@"\n`,
      { mode: 0o755 },
    );
    const git = adapter({ gitBinary: wrapper });
    const base = await cloned(git);
    await writeFile(join(record, 'args'), '');

    const { commit } = await git.publishCommit(PROJECT_ID, remote.url, request(base));

    const invocations = (await readFile(join(record, 'args'), 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split('\0').slice(0, -1));
    const pushes = invocations.filter((args) => args.includes('push'));
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push).toContain(`${commit}:refs/heads/dev`);
    for (const arg of invocations.flat()) {
      expect(arg).not.toMatch(/^--force|^-f$|^\+|--mirror|--delete|--prune|--tags|--all/);
    }
    expect(push).toEqual(
      expect.arrayContaining(['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=']),
    );
    expect(push).toContain('--no-verify');
    // One ref, named by the commit and the branch, after the remote.
    const refspecs = push.slice(push.indexOf('--') + 1);
    expect(refspecs).toEqual([remote.url, `${commit}:refs/heads/dev`]);
  });

  it('answers nothing to commit when the changes make the base tree, and pushes nothing', async () => {
    const git = adapter();
    const base = await cloned(git);
    const before = remoteRefs();

    await expect(
      git.publishCommit(
        PROJECT_ID,
        remote.url,
        request(base, {
          changes: [
            { path: 'agents/old/AGENT.md', content: text('old\n'), executable: false },
            { path: 'agents/never/existed.md', content: null, executable: false },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(GitNothingToCommitError);

    expect(remoteRefs()).toBe(before);
  });

  it('treats a change of only the executable bit as a change', async () => {
    const git = adapter();
    const base = await cloned(git);

    const { commit } = await git.publishCommit(
      PROJECT_ID,
      remote.url,
      request(base, {
        changes: [{ path: 'agents/old/AGENT.md', content: text('old\n'), executable: true }],
      }),
    );

    expect(fixtureGit(remote.path, ['ls-tree', commit, 'agents/old/AGENT.md'])).toMatch(/^100755 /);
  });

  it.each([
    ['an empty path', ''],
    ['a path above the root', '../escape.md'],
    ['an absolute path', '/etc/passwd'],
    ['a path into .git', '.git/config'],
    ['a path into a nested .git', 'agents/x/.git/hooks/pre-push'],
    ['a path with a NUL', 'agents/a\0b.md'],
    ['a backslash path', 'agents\\a.md'],
  ])('refuses %s before anything is written', async (_name, path) => {
    const git = adapter();
    const base = await cloned(git);
    const before = cloneRefs();

    await expect(
      git.publishCommit(
        PROJECT_ID,
        remote.url,
        request(base, { changes: [{ path, content: text('x'), executable: false }] }),
      ),
    ).rejects.toBeInstanceOf(GitRequestRejectedError);

    expect(cloneRefs()).toBe(before);
    expect(remoteRefs()).toBe(`refs/heads/dev ${base}`);
  });

  it.each([
    ['a base that is not a full commit id', { baseCommit: 'main' }],
    ['a branch name Git refuses', { branch: 'a..b' }],
    ['no change at all', { changes: [] }],
    ['an empty message', { message: '' }],
    ['a message with a NUL', { message: 'a\0b' }],
    ['a name with an angle bracket', { identity: { name: 'A <b>', email: 'a@example.test' } }],
    ['a name with a newline', { identity: { name: 'A\nB', email: 'a@example.test' } }],
    ['an email with a newline', { identity: { name: 'A', email: 'a@example.test\nx' } }],
    ['a name that is empty', { identity: { name: '', email: 'a@example.test' } }],
  ] as [string, Partial<PublishRequest>][])('refuses %s', async (_name, overrides) => {
    const git = adapter();
    const base = await cloned(git);

    await expect(
      git.publishCommit(PROJECT_ID, remote.url, request(base, overrides)),
    ).rejects.toBeInstanceOf(GitRequestRejectedError);

    expect(remoteRefs()).toBe(`refs/heads/dev ${base}`);
  });

  it('takes author and committer from the identity only, whatever the message says', async () => {
    const git = adapter();
    const base = await cloned(git);

    const { commit } = await git.publishCommit(
      PROJECT_ID,
      remote.url,
      request(base, { message: 'Subject\n\nauthor Mallory <mallory@example.test> 0 +0000' }),
    );

    expect(fixtureGit(remote.path, ['log', '-1', '--format=%an <%ae>', commit])).toBe(
      'Studio Publisher <studio@example.test>',
    );
  });

  it('lets one of two publishes at once win, and answers the other that the remote moved', async () => {
    const git = adapter();
    const base = await cloned(git);

    const results = await Promise.allSettled([
      git.publishCommit(
        PROJECT_ID,
        remote.url,
        request(base, {
          changes: [{ path: 'agents/one/AGENT.md', content: text('one\n'), executable: false }],
        }),
      ),
      git.publishCommit(
        PROJECT_ID,
        remote.url,
        request(base, {
          changes: [{ path: 'agents/two/AGENT.md', content: text('two\n'), executable: false }],
        }),
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(GitRemoteMovedError);
    expect(fixtureGit(remote.path, ['rev-list', '--count', `${base}..dev`])).toBe('1');
  });

  describe('over ssh, nothing secret or remote-written reaches an answer or a log', () => {
    const KEY_MARKER = 'KEYMATERIALMARKER0123456789';
    const REMOTE_MARKER = 'REMOTETEXTMARKER9876543210';
    const HOST_KEY =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

    function privateKey(): string {
      return [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        Buffer.from(`${KEY_MARKER}-body-of-a-test-key`).toString('base64'),
        KEY_MARKER,
        '-----END OPENSSH PRIVATE KEY-----',
        '',
      ].join('\n');
    }

    async function leakingSsh(): Promise<string> {
      // A stand-in ssh that does the worst it could: print the key it was given and a remote line.
      const path = join(root, 'leaking-ssh');
      await writeFile(
        path,
        [
          '#!/bin/sh',
          'for a in "$@"; do case "$a" in IdentityFile=*) cat "${a#IdentityFile=}" >&2;; esac; done',
          `echo "remote: ${REMOTE_MARKER}" >&2`,
          'echo "git@host: Permission denied (publickey)." >&2',
          'exit 255',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      return path;
    }

    it('keeps a key marker and remote text out of the error and the log of a refused push', async () => {
      const sshBinary = await leakingSsh();
      const git = adapter({ sshBinary });
      const base = await cloned(git);
      const sshUrl = 'ssh://git@127.0.0.1:2/srv/git/defs.git';

      const error = await git
        .publishCommit(PROJECT_ID, sshUrl, request(base), {
          ssh: { privateKey: privateKey(), hostKeys: [HOST_KEY] },
        })
        .then(
          () => {
            throw new Error('expected a refusal');
          },
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(GitWriteRefusedError);
      expect(allOutput(error)).not.toContain(KEY_MARKER);
      expect(allOutput(error)).not.toContain(REMOTE_MARKER);
      expect(allOutput(error)).not.toContain('PRIVATE KEY');
    });

    it('keeps them out when the push fails some other way', async () => {
      // Nothing listens on port 2: ssh itself fails, and the key still stays out.
      const git = adapter();
      const base = await cloned(git);

      const error = await git
        .publishCommit(PROJECT_ID, 'ssh://git@127.0.0.1:2/srv/git/defs.git', request(base), {
          ssh: { privateKey: privateKey(), hostKeys: [HOST_KEY] },
          timeoutMs: 20_000,
        })
        .then(
          () => {
            throw new Error('expected a failure');
          },
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(Error);
      expect(allOutput(error)).not.toContain(KEY_MARKER);
      expect(allOutput(error)).not.toContain('PRIVATE KEY');
    });
  });
});
