import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
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
  parseKnownHosts,
  SSH_HOST_KEY_TYPES,
} from '../../../../../../platform/config/ssh-known-hosts.js';
import {
  gitInvocations,
  keyscanInvocation,
  sshInvocation,
  writeFakeGit,
  writeFakeKeyscan,
  writeFakeSsh,
  type FakeFetch,
} from './fixtures/fake-binaries.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const HTTPS_URL = 'https://git.example.test/owner/repo.git';
const SSH_URL = 'ssh://git@git.example.test:2222/srv/git/repo.git';
/** What the injected resolver answers for git.example.test: a public (TEST-NET-3) address. */
const PUBLIC_ADDRESS = '203.0.113.10';
// A PEM-shaped placeholder and a public host key: test data, not credentials.
const SSH_FIXTURE = {
  privateKey:
    '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS10ZXN0LWtleQ==\n-----END OPENSSH PRIVATE KEY-----\n',
  hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTestsOnly0000000000000000000 host',
};
const SSH: SshCredentials = { privateKey: SSH_FIXTURE.privateKey, hostKeys: [SSH_FIXTURE.hostKey] };

/** A throwaway public key as `<type> <base64>`, generated with ssh-keygen for this run. */
async function generatedPublicKey(dir: string, type: 'ed25519' | 'ecdsa' | 'rsa'): Promise<string> {
  const path = join(dir, `generated-${type}-${Math.random().toString(16).slice(2)}`);
  const result = spawnSync('ssh-keygen', ['-q', '-t', type, '-N', '', '-f', path]);
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${String(result.stderr)}`);
  const [keyType, data] = (await readFile(`${path}.pub`, 'utf8')).trim().split(' ');
  await rm(path, { force: true });
  return `${keyType} ${data}`;
}

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
  'http.followRedirects=false',
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
    /** Host names the injected resolver was asked for, in order. */
    let lookups: string[];
    /** The injected resolver's answers; git.example.test resolves to a public address. */
    let answers: Record<string, string[]>;
    const savedEnv = { ...process.env };

    const resolveHost = async (host: string): Promise<string[]> => {
      lookups.push(host);
      const answer = answers[host];
      if (!answer)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return answer;
    };

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
        allowPrivateRemotes: false,
        resolveHost,
        ...overrides,
      });
    }

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'studio-git-spawn-'));
      dataDir = join(root, 'data');
      tempRoot = join(root, 'tmp');
      recordDir = join(root, 'record');
      await Promise.all([mkdir(dataDir), mkdir(tempRoot), mkdir(recordDir)]);
      lookups = [];
      answers = { 'git.example.test': [PUBLIC_ADDRESS] };
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
        // A proxy would connect for Git, around the address check and the pin (Issue #69).
        http_proxy: 'http://169.254.169.254:80',
        https_proxy: 'http://169.254.169.254:80',
        HTTPS_PROXY: 'http://169.254.169.254:80',
        ALL_PROXY: 'socks5://169.254.169.254:1080',
        all_proxy: 'socks5://169.254.169.254:1080',
        NO_PROXY: '',
      });

      await expect((await adapter()).inspectRemote(HTTPS_URL, 'main')).rejects.toThrow(
        GitOperationError,
      );

      const [invocation] = await gitInvocations(recordDir);
      const { args, env, cwd } = invocation!;
      const settings = args.flatMap((arg, i) => (args[i - 1] === '-c' ? [arg] : []));
      expect(settings).toEqual(expect.arrayContaining(HARDENING));
      expect(settings).not.toContain('protocol.file.allow=always');
      // Pinned to the checked address: Git's own lookup cannot answer differently (rebinding).
      expect(settings).toContain(`http.curloptResolve=git.example.test:443:${PUBLIC_ADDRESS}`);
      expect(lookups).toEqual(['git.example.test']);
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
        git.inspectRemote(SSH_URL, 'main', { ssh: { ...SSH, hostKeys: ['not a key'] } }),
        git.inspectRemote(SSH_URL, 'main', { ssh: { ...SSH, hostKeys: [] } }),
        git.inspectRemote(SSH_URL, 'main', {
          ssh: { ...SSH, hostKeys: [SSH_FIXTURE.hostKey, 'ssh-ed25519 broken!'] },
        }),
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

      it('in a custom temp root, are swept at start-up only when stale; partial Clones always', async () => {
        const clones = join(dataDir, 'clones');
        const old = new Date(Date.now() - 60 * 60 * 1000);
        const removed = [
          join(tempRoot, 'studio-git-stale'),
          join(clones, `${PROJECT_ID}.git.partial-0a1b2c3d4e5f`),
          join(clones, `${PROJECT_ID}.git.partial-ffffffffffff`),
        ];
        const fresh = join(tempRoot, 'studio-git-fresh');
        const unrelated = [join(tempRoot, 'other-tool'), join(clones, `${PROJECT_ID}.git`)];
        for (const dir of [...removed, fresh, ...unrelated]) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(join(removed[0]!, 'deploy_key'), 'stale key');
        for (const dir of [removed[0]!, removed[1]!, unrelated[0]!]) await utimes(dir, old, old);

        // A custom temp root may be shared: the clone limit is 15 s here, so an hour-old
        // directory is stale and a new one may still be in use.
        await (await adapter()).onModuleInit();

        for (const dir of removed) expect(existsSync(dir)).toBe(false);
        for (const dir of [fresh, ...unrelated]) expect(existsSync(dir)).toBe(true);
        await Promise.all([fresh, unrelated[0]!].map((dir) => rm(dir, { recursive: true })));
      });

      it('in the default <dataDir>/tmp, are all swept at start-up, however fresh', async () => {
        // A crash and an immediate restart: the leftover, with its key, is seconds old.
        const leftover = join(dataDir, 'tmp', 'studio-git-crashed');
        await mkdir(leftover, { recursive: true });
        await writeFile(join(leftover, 'deploy_key'), 'key of a crashed operation');

        await (await adapter({}, { tempRoot: undefined })).onModuleInit();

        expect(existsSync(leftover)).toBe(false);
      });

      it.runIf(process.getuid?.() !== 0)(
        'keep sweeping past an entry that cannot be removed, and log it redacted',
        async () => {
          const logs: string[] = [];
          const old = new Date(Date.now() - 60 * 60 * 1000);
          const stuck = join(tempRoot, 'studio-git-stuck');
          await mkdir(join(stuck, 'locked', 'inner'), { recursive: true });
          await chmod(join(stuck, 'locked'), 0o500);
          await utimes(stuck, old, old);
          const partial = join(dataDir, 'clones', `${PROJECT_ID}.git.partial-0a1b2c3d4e5f`);
          await mkdir(partial, { recursive: true });

          try {
            await (await adapter({}, { log: (m) => logs.push(m) })).onModuleInit();

            expect(existsSync(partial)).toBe(false);
            expect(logs).toHaveLength(1);
            expect(logs[0]).not.toContain(root);
          } finally {
            await chmod(join(stuck, 'locked'), 0o700);
            await rm(stuck, { recursive: true, force: true });
          }
        },
      );

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
      // 2.37 is the first Git with http.curloptResolve, which pins HTTPS to the checked address.
      it.each(['2.37.0', '2.43.0', '3.0.1'])('accepts git %s', async (version) => {
        await expect((await adapter({ version })).verifyGitVersion()).resolves.toBe(version);
      });

      it.each(['2.36.9', '2.32.0', '2.9.5', '1.9.0'])(
        'refuses git %s with a clear error',
        async (version) => {
          await expect((await adapter({ version })).onModuleInit()).rejects.toThrow(
            /need git 2\.37\.0 or later; found "git version /,
          );
        },
      );

      it('refuses a missing git with a clear error', async () => {
        await expect(
          (await adapter('real', { gitBinary: join(root, 'no-such-git') })).onModuleInit(),
        ).rejects.toThrow(/need git 2\.37\.0 or later, but git could not be run/);
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
            // Connects to the checked address; host-key trust stays with the alias (Issue #69).
            `HostName=${PUBLIC_ADDRESS}`,
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

      it('trusts every supplied host key of the host, all pinned to the alias', async () => {
        const sshBinary = await writeFakeSsh(root, recordDir, 'deny');
        const git = await adapter('real', { sshBinary });
        const other = await generatedPublicKey(root, 'ecdsa');

        await git
          .inspectRemote(SSH_URL, 'main', { ssh: { ...SSH, hostKeys: [SSH.hostKeys[0]!, other] } })
          .catch(() => undefined);

        const [first = ''] = SSH.hostKeys[0]!.split(' host');
        expect((await sshInvocation(recordDir)).knownHosts).toBe(
          `studio-remote ${first}\nstudio-remote ${other}\n`,
        );
      });

      it('accepts exactly the host keys STUDIO_SSH_KNOWN_HOSTS accepts (one shared allowlist)', async () => {
        const sshBinary = await writeFakeSsh(root, recordDir, 'deny');
        const git = await adapter('real', { sshBinary });
        const keyOfType = (type: string) => {
          const name = Buffer.from(type, 'latin1');
          const length = Buffer.alloc(4);
          length.writeUInt32BE(name.length);
          return `${type} ${Buffer.concat([length, name, Buffer.alloc(32, 7)]).toString('base64')}`;
        };
        const verdicts = async (key: string) => {
          const config = parseKnownHosts(`git.example.test ${key}`).problems.length === 0;
          const error = await git
            .inspectRemote(SSH_URL, 'main', { ssh: { ...SSH, hostKeys: [key] } })
            .catch((e: unknown) => e);
          return { config, adapter: !(error instanceof GitRequestRejectedError) };
        };

        for (const type of SSH_HOST_KEY_TYPES) {
          expect(await verdicts(keyOfType(type))).toEqual({ config: true, adapter: true });
        }
        for (const key of [
          keyOfType('ssh-dss'),
          `ssh-rsa ${keyOfType('ssh-ed25519').split(' ')[1]}`,
          'ssh-ed25519 not-base64!',
        ]) {
          expect(await verdicts(key)).toEqual({ config: false, adapter: false });
        }
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

    describe('scanHostKey', () => {
      it("runs ssh-keyscan isolated, for the URL's host and port, and prefers ed25519", async () => {
        Object.assign(process.env, { SSH_AUTH_SOCK: '/tmp/agent.sock' });
        const [ed25519, ecdsa, rsa] = await Promise.all([
          generatedPublicKey(root, 'ed25519'),
          generatedPublicKey(root, 'ecdsa'),
          generatedPublicKey(root, 'rsa'),
        ]);
        const keyscanBinary = await writeFakeKeyscan(root, recordDir, {
          stdout: `[git.example.test]:2222 ${rsa}\n[git.example.test]:2222 ${ecdsa}\n[git.example.test]:2222 ${ed25519}\n`,
          stderr: '# git.example.test:2222 SSH-2.0-OpenSSH_9.6\n',
        });
        const git = await adapter({}, { keyscanBinary });

        await expect(git.scanHostKey(SSH_URL)).resolves.toEqual({ hostKey: ed25519 });

        const scan = await keyscanInvocation(recordDir);
        expect(scan.args).toEqual([
          '-T',
          expect.stringMatching(/^\d+$/),
          '-p',
          '2222',
          '-t',
          'ed25519,ecdsa,rsa',
          '--',
          PUBLIC_ADDRESS,
        ]);
        expect(scan.env.SSH_AUTH_SOCK).toBeUndefined();
        expect(scan.env.HOME?.startsWith(join(tempRoot, 'studio-git-'))).toBe(true);
      });

      it('takes ECDSA, then RSA, when the host has no ed25519 key; port 22 for scp-like URLs', async () => {
        const [ecdsa, rsa] = await Promise.all([
          generatedPublicKey(root, 'ecdsa'),
          generatedPublicKey(root, 'rsa'),
        ]);
        let keyscanBinary = await writeFakeKeyscan(root, recordDir, {
          stdout: `git.example.test ${rsa}\ngit.example.test ${ecdsa}\n`,
        });
        await expect(
          (await adapter({}, { keyscanBinary })).scanHostKey('git@git.example.test:owner/repo.git'),
        ).resolves.toEqual({ hostKey: ecdsa });
        expect((await keyscanInvocation(recordDir)).args).toEqual(
          expect.arrayContaining(['-p', '22', '--', PUBLIC_ADDRESS]),
        );

        keyscanBinary = await writeFakeKeyscan(root, recordDir, {
          stdout: `git.example.test ${rsa}\n`,
        });
        await expect(
          (await adapter({}, { keyscanBinary })).scanHostKey('git@git.example.test:owner/repo.git'),
        ).resolves.toEqual({ hostKey: rsa });
      });

      it('fails with host_unreachable, redacted, when the host presents no usable key', async () => {
        const keyscanBinary = await writeFakeKeyscan(root, recordDir, {
          stdout: 'git.example.test ssh-ed25519 not-base64!\n',
          stderr: `getaddrinfo git.example.test: Name or service not known (${root})\n`,
        });

        const error = await (
          await adapter({}, { keyscanBinary })
        )
          .scanHostKey(SSH_URL)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(GitOperationError);
        expect(error).toMatchObject({ reason: 'host_unreachable' });
        expect((error as GitOperationError).detail).not.toContain(root);
      });

      it('fails with timeout when ssh-keyscan hangs, leaving no temporary directory', async () => {
        const keyscanBinary = await writeFakeKeyscan(root, recordDir, 'hang');
        const git = await adapter({}, { keyscanBinary, fetchTimeoutMs: 700 });

        await expect(git.scanHostKey(SSH_URL)).rejects.toMatchObject({ reason: 'timeout' });
        // afterEach: the temporary root is empty.
      });

      it('refuses a remote that is not ssh before anything runs', async () => {
        const keyscanBinary = await writeFakeKeyscan(root, recordDir, { stdout: '' });
        const git = await adapter({}, { keyscanBinary });

        await expect(git.scanHostKey(HTTPS_URL)).rejects.toThrow(GitRequestRejectedError);
        await expect(git.scanHostKey('ssh://git@-oProxyCommand=x/repo.git')).rejects.toThrow(
          GitRequestRejectedError,
        );
        expect(existsSync(join(recordDir, 'keyscan.args'))).toBe(false);
      });
    });

    describe('remote address policy (Issue #69)', () => {
      const settingsOf = (args: string[]) =>
        args.flatMap((arg, i) => (args[i - 1] === '-c' ? [arg] : []));
      const keyscanStub = () => writeFakeKeyscan(root, recordDir, { stdout: '' });

      /** Every operation that reaches a remote, against `url`, with what an ssh remote needs. */
      async function everyRemoteOperation(git: SystemGitAdapter, url: string) {
        const ssh = url.startsWith('ssh:') || url.startsWith('git@') ? { ssh: SSH } : {};
        await mkdir(join(dataDir, 'clones', `${PROJECT_ID}.git`, 'objects', 'pack'), {
          recursive: true,
        });
        const attempts = [
          git.inspectRemote(url, 'main', ssh),
          git.clone(OTHER_PROJECT_ID, url, 'main', ssh),
          git.fetch(PROJECT_ID, url, 'main', ssh),
          ...(ssh.ssh ? [git.scanHostKey(url)] : []),
        ];
        return Promise.all(attempts.map((attempt) => attempt.catch((e: unknown) => e)));
      }

      it.each([
        ['169.254.169.254', 'a link-local'],
        ['100.100.100.200', 'a metadata'],
        ['fd00:ec2::254', 'an IPv6 metadata'],
        ['::ffff:169.254.169.254', 'an IPv4-mapped link-local'],
        ['224.0.0.1', 'a multicast'],
      ])(
        'refuses a host resolving to %s (%s address) before any process starts, even with the opt-in',
        async (address) => {
          answers['git.example.test'] = [address];
          const keyscanBinary = await keyscanStub();
          const git = await adapter({}, { allowPrivateRemotes: true, keyscanBinary });

          for (const url of [HTTPS_URL, SSH_URL]) {
            for (const error of await everyRemoteOperation(git, url)) {
              expect(error).toBeInstanceOf(GitOperationError);
              expect(error).toMatchObject({ reason: 'remote_not_allowed' });
              expect((error as GitOperationError).detail).toBe(
                `git.example.test resolves to ${address}, a link-local, metadata, multicast or reserved address. Studio never connects to it.`,
              );
            }
          }
          expect(await gitInvocations(recordDir)).toEqual([]);
          expect(existsSync(join(recordDir, 'keyscan.args'))).toBe(false);
        },
      );

      it('refuses a loopback or private address unless STUDIO_GIT_ALLOW_PRIVATE_REMOTES opts in', async () => {
        answers['git.example.test'] = ['10.0.0.5'];
        const keyscanBinary = await keyscanStub();

        for (const url of [HTTPS_URL, SSH_URL]) {
          for (const error of await everyRemoteOperation(
            await adapter({}, { keyscanBinary }),
            url,
          )) {
            expect(error).toMatchObject({
              reason: 'remote_not_allowed',
              detail:
                'git.example.test resolves to 10.0.0.5, a loopback or private address. Studio connects to loopback and private addresses only with STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true.',
            });
          }
        }
        expect(await gitInvocations(recordDir)).toEqual([]);

        await (
          await adapter({}, { allowPrivateRemotes: true })
        )
          .inspectRemote(HTTPS_URL, 'main')
          .catch(() => undefined);
        const [invocation] = await gitInvocations(recordDir);
        expect(settingsOf(invocation!.args)).toContain(
          'http.curloptResolve=git.example.test:443:10.0.0.5',
        );
      });

      it('refuses the host when any one of its addresses is refused', async () => {
        answers['git.example.test'] = [PUBLIC_ADDRESS, '2001:db8::1', '127.0.0.1'];

        await expect((await adapter()).inspectRemote(HTTPS_URL, 'main')).rejects.toMatchObject({
          reason: 'remote_not_allowed',
          detail: expect.stringContaining('resolves to 127.0.0.1'),
        });
        expect(await gitInvocations(recordDir)).toEqual([]);
      });

      it('pins HTTPS to every checked address, IPv6 in brackets, on the URL port', async () => {
        answers['git.example.test'] = [PUBLIC_ADDRESS, '2001:db8::1'];

        await (
          await adapter()
        )
          .inspectRemote('https://git.example.test:8443/owner/repo.git', 'main')
          .catch(() => undefined);

        const [invocation] = await gitInvocations(recordDir);
        expect(settingsOf(invocation!.args)).toContain(
          `http.curloptResolve=git.example.test:8443:${PUBLIC_ADDRESS},[2001:db8::1]`,
        );
      });

      it('resolves once per operation and pins that answer: a rebinding resolver cannot redirect Git', async () => {
        const sequence = [[PUBLIC_ADDRESS], ['169.254.169.254']];
        const rebinding = async (host: string) => {
          lookups.push(host);
          return sequence.shift() ?? ['169.254.169.254'];
        };
        const git = await adapter({}, { resolveHost: rebinding });

        await git.clone(PROJECT_ID, HTTPS_URL, 'main').catch(() => undefined);

        expect(lookups).toEqual(['git.example.test']);
        const fetch = (await gitInvocations(recordDir)).find((call) => call.args.includes('fetch'));
        expect(settingsOf(fetch!.args)).toContain(
          `http.curloptResolve=git.example.test:443:${PUBLIC_ADDRESS}`,
        );
      });

      it('checks IP-literal hosts without a lookup, in their numeric forms too', async () => {
        const git = await adapter({}, { allowPrivateRemotes: true });

        for (const url of [
          'https://169.254.169.254/latest/meta-data.git',
          'https://[fe80::1]/owner/repo.git',
          'https://[::ffff:a9fe:a9fe]/owner/repo.git',
          'ssh://git@0xa9.0xfe.0xa9.0xfe/srv/repo.git',
          'git@2852039166:owner/repo.git',
        ]) {
          const ssh = url.startsWith('https:') ? {} : { ssh: SSH };
          await expect(git.inspectRemote(url, 'main', ssh)).rejects.toMatchObject({
            reason: 'remote_not_allowed',
          });
        }
        expect(lookups).toEqual([]);
        expect(await gitInvocations(recordDir)).toEqual([]);
      });

      it('connects ssh and ssh-keyscan to the first IPv4 address of a dual-stack host', async () => {
        answers['git.example.test'] = ['2001:db8::1', PUBLIC_ADDRESS];
        const sshBinary = await writeFakeSsh(root, recordDir, 'deny');
        const keyscanBinary = await writeFakeKeyscan(root, recordDir, { stdout: '' });
        const git = await adapter('real', { sshBinary, keyscanBinary });

        await git.inspectRemote(SSH_URL, 'main', { ssh: SSH }).catch(() => undefined);
        await git.scanHostKey(SSH_URL).catch(() => undefined);

        expect((await sshInvocation(recordDir)).args).toEqual(
          expect.arrayContaining(['-o', `HostName=${PUBLIC_ADDRESS}`]),
        );
        expect((await keyscanInvocation(recordDir)).args.at(-1)).toBe(PUBLIC_ADDRESS);
      });

      it('connects ssh to the normalized literal address', async () => {
        const sshBinary = await writeFakeSsh(root, recordDir, 'deny');
        const git = await adapter('real', { sshBinary, allowPrivateRemotes: true });

        await git
          .inspectRemote('ssh://git@0x7f.1:2222/srv/repo.git', 'main', { ssh: SSH })
          .catch(() => undefined);

        const ssh = await sshInvocation(recordDir);
        expect(ssh.args).toEqual(expect.arrayContaining(['-o', 'HostName=127.0.0.1']));
        expect(lookups).toEqual([]);
      });

      it('fails with host_unreachable when the host does not resolve, before Git starts', async () => {
        const error = await (
          await adapter()
        )
          .inspectRemote('https://nope.example.test/owner/repo.git', 'main')
          .catch((e: unknown) => e);

        expect(error).toMatchObject({
          reason: 'host_unreachable',
          detail: 'Could not resolve host: nope.example.test',
        });
        expect(await gitInvocations(recordDir)).toEqual([]);
      });

      it('counts the lookup against the time limit', async () => {
        const hanging = () => new Promise<string[]>(() => {});
        const git = await adapter({}, { resolveHost: hanging, fetchTimeoutMs: 300 });

        await expect(git.inspectRemote(HTTPS_URL, 'main')).rejects.toMatchObject({
          reason: 'timeout',
        });
        expect(await gitInvocations(recordDir)).toEqual([]);
      });

      it('aborts a pending lookup', async () => {
        const hanging = () => new Promise<string[]>(() => {});
        const git = await adapter({}, { resolveHost: hanging });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);

        await expect(
          git.inspectRemote(HTTPS_URL, 'main', { signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
      });

      it('never resolves a file remote', async () => {
        const git = await adapter({}, { allowedTransports: ['ssh', 'https', 'file'] });
        await git.inspectRemote('file:///srv/fixture.git', 'main').catch(() => undefined);

        expect(lookups).toEqual([]);
        const [invocation] = await gitInvocations(recordDir);
        expect(settingsOf(invocation!.args).some((s) => s.startsWith('http.curloptResolve'))).toBe(
          false,
        );
      });
    });
  },
);
