import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitOperationError,
  GitRequestRejectedError,
  type SshCredentials,
} from '../../../../ports/repository-git.js';
import { SystemGitAdapter, type SystemGitSettings } from '../system-git-adapter.js';
import {
  gitInvocations,
  sshInvocation,
  writeFakeGit,
  writeFakeSsh,
  type FakeFetch,
} from './fixtures/fake-binaries.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HTTPS_URL = 'https://git.example.test/owner/repo.git';
const SSH_URL = 'ssh://git@git.example.test:2222/srv/git/repo.git';
// A PEM-shaped placeholder and a public host key: test data, not credentials.
const SSH: SshCredentials = {
  privateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS10ZXN0LWtleQ==\n-----END OPENSSH PRIVATE KEY-----\n',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTestsOnly0000000000000000000 host',
};

/** Settings every hardened Git command must carry (security.md §4). */
const HARDENING = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'fetch.writeCommitGraph=false',
  'credential.helper=',
  'protocol.allow=never',
  'protocol.ssh.allow=always',
  'protocol.https.allow=always',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'filter.lfs.smudge=',
  'filter.lfs.process=',
  'filter.lfs.required=false',
  'gc.auto=0',
  'maintenance.auto=false',
];

/**
 * The hardening asserted where the adapter starts processes: stand-in `git` and `ssh`
 * binaries record their arguments, environment and working directory. Linux only.
 */
describe.runIf(process.platform === 'linux')(
  'SystemGitAdapter at the process-spawn boundary',
  () => {
    let root: string;
    let dataDir: string;
    let tempRoot: string;
    let recordDir: string;
    const savedEnv = { ...process.env };

    async function adapter(
      fakeGit: { version?: string; fetch?: FakeFetch } | 'real' = {},
      overrides: Partial<SystemGitSettings> = {},
    ): Promise<SystemGitAdapter> {
      return new SystemGitAdapter({
        dataDir,
        allowedTransports: ['ssh', 'https'],
        cloneTimeoutMs: 15_000,
        fetchTimeoutMs: 15_000,
        maxCloneBytes: 1024 * 1024,
        sizePollIntervalMs: 20,
        tempRoot,
        log: () => {},
        gitBinary: fakeGit === 'real' ? 'git' : await writeFakeGit(root, recordDir, fakeGit),
        ...overrides,
      });
    }

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'studio-git-spawn-'));
      dataDir = join(root, 'data');
      tempRoot = join(root, 'tmp');
      recordDir = join(root, 'record');
      await Promise.all([mkdir(dataDir), mkdir(tempRoot), mkdir(recordDir)]);
    });

    afterEach(async () => {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
      expect(await readdir(tempRoot)).toEqual([]);
      await rm(root, { recursive: true, force: true });
    });

    it('starts git with a fresh, isolated environment and the hardening settings', async () => {
      // Hostile values in the API's own environment must not reach Git.
      Object.assign(process.env, {
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/tmp/evil'",
        GIT_CONFIG_SYSTEM: '/tmp/evil-system-config',
        GIT_SSH_COMMAND: 'evil-ssh',
        GIT_ASKPASS: '/tmp/evil-askpass',
        GIT_DIR: '/tmp/evil-git-dir',
        XDG_CONFIG_HOME: '/tmp/evil-xdg',
        DATABASE_URL: 'postgresql://user:do-not-leak@db/studio',
      });

      await expect((await adapter()).inspectRemote(HTTPS_URL, 'main')).rejects.toThrow(
        GitOperationError,
      );

      const [invocation] = await gitInvocations(recordDir);
      const { args, env, cwd } = invocation!;
      const settings = args.flatMap((arg, i) => (args[i - 1] === '-c' ? [arg] : []));
      expect(settings).toEqual(expect.arrayContaining(HARDENING));
      expect(settings).not.toContain('protocol.file.allow=always');
      expect(args.slice(-5)).toEqual([
        'ls-remote',
        '--symref',
        HTTPS_URL,
        'HEAD',
        'refs/heads/main',
      ]);

      // The stand-in's shell adds `PWD`, `OLDPWD`, `SHLVL` and `_`; the adapter does not.
      const gitEnv = Object.fromEntries(
        Object.entries(env).filter(([key]) => !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(key)),
      );
      expect(gitEnv).toEqual({
        PATH: process.env.PATH,
        HOME: cwd,
        LC_ALL: 'C',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CEILING_DIRECTORIES: tempRoot,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'ssh:https',
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        SSH_ASKPASS_REQUIRE: 'never',
      });
      // A private per-operation directory outside the data directory, deleted afterwards.
      expect(cwd.startsWith(join(tempRoot, 'studio-git-'))).toBe(true);
      expect(existsSync(cwd)).toBe(false);
    });

    it('adds the file transport only when the allowed set includes it', async () => {
      const git = await adapter({}, { allowedTransports: ['ssh', 'https', 'file'] });
      await expect(git.inspectRemote('file:///srv/fixture.git', 'main')).rejects.toThrow(
        GitOperationError,
      );
      const [invocation] = await gitInvocations(recordDir);
      expect(invocation!.args).toContain('protocol.file.allow=always');
      expect(invocation!.env.GIT_ALLOW_PROTOCOL).toBe('ssh:https:file');
    });

    it('never starts git for a rejected request', async () => {
      const git = await adapter();
      const rejected: Promise<unknown>[] = [
        git.inspectRemote('file:///srv/repo.git', 'main'),
        git.inspectRemote('git://git.example.test/repo.git', 'main'),
        git.inspectRemote('http://git.example.test/repo.git', 'main'),
        git.inspectRemote('/srv/repo.git', 'main'),
        git.inspectRemote('https://user:secret@git.example.test/repo.git', 'main'),
        git.inspectRemote(HTTPS_URL, '-main'),
        git.inspectRemote(HTTPS_URL, 'a..b'),
        git.inspectRemote(HTTPS_URL, '/main'),
        git.inspectRemote(SSH_URL, 'main'),
        git.inspectRemote(SSH_URL, 'main', { ssh: { ...SSH, hostKey: 'not a key' } }),
        git.inspectRemote(SSH_URL, 'main', { ssh: { ...SSH, privateKey: 'not a key' } }),
        git.clone('../escape', HTTPS_URL, 'main'),
        git.fetch(PROJECT_ID, 'ext::sh', 'main'),
      ];
      for (const attempt of rejected) {
        await expect(attempt).rejects.toThrow(GitRequestRejectedError);
      }
      expect(await gitInvocations(recordDir)).toEqual([]);
      expect(existsSync(join(dataDir, 'clones'))).toBe(false);
    });

    it('redacts credentials and paths from the error detail and the log', async () => {
      const logs: string[] = [];
      const git = await adapter({}, { log: (message) => logs.push(message) });
      const error = (await git
        .inspectRemote(HTTPS_URL, 'main')
        .catch((e: unknown) => e)) as GitOperationError;

      expect(error.reason).toBe('auth_failed');
      expect(logs).toHaveLength(1);
      for (const text of [error.detail, error.message, logs[0]!]) {
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain(root);
      }
    });

    it('kills a clone that grows past the size limit while it runs, and removes it', async () => {
      const started = Date.now();
      const error = await (
        await adapter({ fetch: 'grow-and-hang' })
      )
        .clone(PROJECT_ID, HTTPS_URL, 'main')
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ reason: 'size_limit' });
      // Killed by the size watch, long before the 15 s time limit.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await readdir(join(dataDir, 'clones'))).toEqual([]);
    });

    it('kills a fetch that grows past the size limit and removes the Clone', async () => {
      const clone = join(dataDir, 'clones', `${PROJECT_ID}.git`);
      await mkdir(join(clone, 'objects', 'pack'), { recursive: true });
      const git = await adapter({ fetch: 'grow-and-hang' });

      await expect(git.fetch(PROJECT_ID, HTTPS_URL, 'main')).rejects.toMatchObject({
        reason: 'size_limit',
      });
      // A size_limit fetch leaves no usable Clone: the caller clones again (#61).
      expect(await readdir(join(dataDir, 'clones'))).toEqual([]);
    });

    describe('unexpected failures become GitOperationError(unknown) without paths', () => {
      it('maps a file-system error during a clone (the Clone appeared meanwhile)', async () => {
        const logs: string[] = [];
        const git = await adapter({ fetch: 'occupy-target' }, { log: (m) => logs.push(m) });

        const error = await git.clone(PROJECT_ID, HTTPS_URL, 'main').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(GitOperationError);
        expect(error).toMatchObject({ reason: 'unknown', detail: 'ENOTEMPTY' });
        expect(logs).toHaveLength(1);
        for (const text of [(error as Error).message, logs[0]!]) {
          expect(text).not.toContain(root);
        }
        expect(logs[0]).toMatch(/ENOTEMPTY/);
      });

      it('maps an unusable temporary directory', async () => {
        const notADirectory = join(root, 'not-a-directory');
        await writeFile(notADirectory, '');
        const logs: string[] = [];
        const git = await adapter({}, { tempRoot: notADirectory, log: (m) => logs.push(m) });

        const error = await git.inspectRemote(HTTPS_URL, 'main').catch((e: unknown) => e);

        expect(error).toBeInstanceOf(GitOperationError);
        expect((error as GitOperationError).reason).toBe('unknown');
        for (const text of [(error as GitOperationError).detail, logs.join('\n')]) {
          expect(text).not.toContain(root);
        }
      });
    });

    describe('per-operation directories', () => {
      it('live in an owner-only tmp folder of the data directory by default', async () => {
        const git = await adapter({}, { tempRoot: undefined });
        await expect(git.inspectRemote(HTTPS_URL, 'main')).rejects.toThrow(GitOperationError);
        const [invocation] = await gitInvocations(recordDir);
        expect(invocation!.cwd.startsWith(join(dataDir, 'tmp', 'studio-git-'))).toBe(true);
        expect((await stat(join(dataDir, 'tmp'))).mode & 0o777).toBe(0o700);
        expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
      });

      it('are swept at start-up when stale, with stale partial Clones', async () => {
        const clones = join(dataDir, 'clones');
        const old = new Date(Date.now() - 60 * 60 * 1000);
        const stale = [
          join(tempRoot, 'studio-git-stale'),
          join(clones, `${PROJECT_ID}.git.partial-0a1b2c3d4e5f`),
        ];
        const fresh = [
          join(tempRoot, 'studio-git-fresh'),
          join(clones, `${PROJECT_ID}.git.partial-ffffffffffff`),
        ];
        const unrelated = [join(tempRoot, 'other-tool'), join(clones, `${PROJECT_ID}.git`)];
        for (const dir of [...stale, ...fresh, ...unrelated]) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(join(stale[0]!, 'deploy_key'), 'stale key');
        for (const dir of [...stale, unrelated[0]!]) await utimes(dir, old, old);

        // The clone limit is 15 s here: an hour-old directory is stale, a new one is not.
        await (await adapter()).onModuleInit();

        for (const dir of stale) expect(existsSync(dir)).toBe(false);
        for (const dir of [...fresh, ...unrelated]) expect(existsSync(dir)).toBe(true);
        await Promise.all([...fresh, unrelated[0]!].map((dir) => rm(dir, { recursive: true })));
      });

      it('leaves stale directories of other users alone', async () => {
        const old = new Date(Date.now() - 60 * 60 * 1000);
        const othersDir = join(tempRoot, 'studio-git-other-user');
        await mkdir(othersDir);
        await utimes(othersDir, old, old);

        // As if the API ran as another user than the one owning the directory.
        await (await adapter({}, { uid: (process.getuid?.() ?? 0) + 1 })).onModuleInit();

        expect(existsSync(othersDir)).toBe(true);
        await rm(othersDir, { recursive: true });
      });
    });

    describe('start-up version check', () => {
      it.each(['2.32.0', '2.43.0', '3.0.1'])('accepts git %s', async (version) => {
        await expect((await adapter({ version })).verifyGitVersion()).resolves.toBe(version);
      });

      it.each(['2.31.9', '2.9.5', '1.9.0'])(
        'refuses git %s with a clear error',
        async (version) => {
          await expect((await adapter({ version })).onModuleInit()).rejects.toThrow(
            /need git 2\.32\.0 or later; found "git version /,
          );
        },
      );

      it('refuses a missing git with a clear error', async () => {
        await expect(
          (await adapter('real', { gitBinary: join(root, 'no-such-git') })).onModuleInit(),
        ).rejects.toThrow(/need git 2\.32\.0 or later, but git could not be run/);
      });
    });

    describe('SSH', () => {
      it('uses only the supplied key and host key: owner-only key file outside any Clone, deleted afterwards', async () => {
        Object.assign(process.env, { SSH_AUTH_SOCK: '/tmp/agent.sock' });
        const sshBinary = await writeFakeSsh(root, recordDir, 'deny');
        const git = await adapter('real', { sshBinary });

        const error = await git
          .inspectRemote(SSH_URL, 'main', { ssh: SSH })
          .catch((e: unknown) => e);

        expect(error).toMatchObject({ reason: 'auth_failed' });
        const ssh = await sshInvocation(recordDir);
        expect(ssh.args.slice(0, 2)).toEqual(['-F', '/dev/null']);
        const options = ssh.args.flatMap((arg, i) => (ssh.args[i - 1] === '-o' ? [arg] : []));
        expect(options).toEqual(
          expect.arrayContaining([
            'BatchMode=yes',
            'StrictHostKeyChecking=yes',
            'GlobalKnownHostsFile=/dev/null',
            'HostKeyAlias=studio-remote',
            'IdentitiesOnly=yes',
            'IdentityAgent=none',
            'PasswordAuthentication=no',
            'KbdInteractiveAuthentication=no',
            'ForwardAgent=no',
            'UpdateHostKeys=no',
            'ProxyCommand=none',
            'CheckHostIP=no',
            'ClearAllForwardings=yes',
            'PermitLocalCommand=no',
            'ControlMaster=no',
            'ControlPath=none',
            'PubkeyAuthentication=yes',
            'PreferredAuthentications=publickey',
            'ForwardX11=no',
            `IdentityFile=${ssh.keyPath}`,
          ]),
        );
        expect(ssh.args).toEqual(expect.arrayContaining(['-p', '2222', 'git@git.example.test']));
        expect(ssh.env.SSH_AUTH_SOCK).toBeUndefined();
        expect(ssh.keyMode).toBe('600');
        expect(ssh.key).toBe(SSH.privateKey);
        expect(ssh.knownHosts).toBe(
          'studio-remote ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTestsOnly0000000000000000000\n',
        );
        expect(ssh.keyPath.startsWith(join(tempRoot, 'studio-git-'))).toBe(true);
        expect(ssh.keyPath.startsWith(dataDir)).toBe(false);
        expect(existsSync(ssh.keyPath)).toBe(false);
      });

      it('deletes the key when the operation is aborted', async () => {
        const sshBinary = await writeFakeSsh(root, recordDir, 'hang');
        const git = await adapter('real', { sshBinary });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 500);

        await expect(
          git.clone(PROJECT_ID, SSH_URL, 'main', { ssh: SSH, signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });

        const { keyPath } = await sshInvocation(recordDir).catch(() => ({ keyPath: '' }));
        if (keyPath) expect(existsSync(keyPath)).toBe(false);
        expect(await readdir(join(dataDir, 'clones'))).toEqual([]);
      });

      it('deletes the key when the operation times out', async () => {
        const sshBinary = await writeFakeSsh(root, recordDir, 'hang');
        const git = await adapter('real', { sshBinary, fetchTimeoutMs: 700 });

        await expect(git.inspectRemote(SSH_URL, 'main', { ssh: SSH })).rejects.toMatchObject({
          reason: 'timeout',
        });
        // afterEach: the temporary root, which held the key, is empty.
      });
    });
  },
);
