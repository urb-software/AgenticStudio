import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateDeployKey } from '../../../../domain/value-objects/ssh-key.js';
import type { SshCredentials } from '../../../../ports/repository-git.js';
import { SystemGitAdapter, type SystemGitSettings } from '../system-git-adapter.js';

const PROJECT_ID = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const SERVER_CONTEXT = join(import.meta.dirname, 'fixtures', 'ssh-server');

interface KeyPair {
  privateKey: string;
  /** `<type> <base64>`, without the comment. */
  publicKey: string;
}

/** A throwaway ed25519 key pair, generated for this test run only. */
async function generateKeyPair(dir: string, name: string): Promise<KeyPair> {
  const path = join(dir, name);
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', path]);
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`);
  const [type, data] = (await readFile(`${path}.pub`, 'utf8')).trim().split(' ');
  return { privateKey: await readFile(path, 'utf8'), publicKey: `${type} ${data}` };
}

/**
 * The SSH path against a real OpenSSH + Git server in a throwaway container (image built
 * from fixtures/ssh-server, base pinned by digest). Keys are generated per run. Linux and
 * Docker are required; CI runs this on ubuntu-24.04.
 */
describe.runIf(process.platform === 'linux')('SystemGitAdapter over SSH (container)', () => {
  let keysDir: string;
  let container: StartedTestContainer;
  let url: string;
  let deployKey: KeyPair;
  let otherKey: KeyPair;
  let hostKey: KeyPair;
  let otherHostKey: KeyPair;

  let root: string;
  let dataDir: string;
  let tempRoot: string;

  beforeAll(async () => {
    keysDir = await mkdtemp(join(tmpdir(), 'studio-ssh-keys-'));
    [deployKey, otherKey, hostKey, otherHostKey] = await Promise.all(
      ['deploy', 'other', 'host', 'other-host'].map((name) => generateKeyPair(keysDir, name)),
    );
    const image = await GenericContainer.fromDockerfile(SERVER_CONTEXT).build(
      'agentic-studio-test-ssh-git:59',
      { deleteOnExit: false },
    );
    container = await image
      .withCopyContentToContainer([
        { content: hostKey.privateKey, target: '/etc/ssh/test_host_ed25519_key', mode: 0o600 },
        {
          content: `${deployKey.publicKey}\n`,
          target: '/etc/ssh/authorized_keys/git',
          mode: 0o644,
        },
      ])
      .withExposedPorts(22)
      .withWaitStrategy(Wait.forLogMessage(/Server listening on/))
      .start();
    url = `ssh://git@${container.getHost()}:${container.getMappedPort(22)}/srv/git/repo.git`;
  });

  afterAll(async () => {
    await container?.stop();
    await rm(keysDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-ssh-test-'));
    dataDir = join(root, 'data');
    tempRoot = join(root, 'tmp');
    await Promise.all([mkdir(dataDir), mkdir(tempRoot)]);
  });

  afterEach(async () => {
    // The private key never outlives the operation.
    expect(await readdir(tempRoot)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  function adapter(overrides: Partial<SystemGitSettings> = {}): SystemGitAdapter {
    return new SystemGitAdapter({
      dataDir,
      allowedTransports: ['ssh', 'https'],
      cloneTimeoutMs: 60_000,
      fetchTimeoutMs: 60_000,
      maxCloneBytes: 50 * 1024 * 1024,
      tempRoot,
      log: () => {},
      // The container's port is published on the Docker host's loopback: an explicit opt-in.
      allowPrivateRemotes: true,
      ...overrides,
    });
  }

  const credentials = (key: KeyPair, host: KeyPair): SshCredentials => ({
    privateKey: key.privateKey,
    hostKeys: [host.publicKey],
  });

  it('inspects, clones and fetches with the Deploy key and the pinned host key', async () => {
    const git = adapter();
    const ssh = credentials(deployKey, hostKey);

    await expect(git.inspectRemote(url, 'main', { ssh })).resolves.toEqual({
      defaultBranch: 'main',
      branchExists: true,
    });
    const { commit } = await git.clone(PROJECT_ID, url, 'main', { ssh });
    expect(commit).toMatch(/^[\da-f]{40}$/);
    await expect(git.fetch(PROJECT_ID, url, 'main', { ssh })).resolves.toEqual({ commit });
  });

  it('fails with auth_failed for a key the server does not accept', async () => {
    await expect(
      adapter().clone(PROJECT_ID, url, 'main', { ssh: credentials(otherKey, hostKey) }),
    ).rejects.toMatchObject({ reason: 'auth_failed' });
    expect(await readdir(join(dataDir, 'clones'))).toEqual([]);
  });

  it('retrieves the host key the server presents (ssh-keyscan)', async () => {
    await expect(adapter().scanHostKey(url)).resolves.toEqual({ hostKey: hostKey.publicKey });
  });

  it('authenticates with a Deploy key generated by Studio (Node crypto, OpenSSH format)', async () => {
    const generated = generateDeployKey('studio-adapter-test');
    const added = await container.exec([
      'sh',
      '-c',
      `printf '%s\n' '${generated.publicKey}' >> /etc/ssh/authorized_keys/git`,
    ]);
    expect(added.exitCode).toBe(0);

    const ssh = { privateKey: generated.privateKey, hostKeys: [hostKey.publicKey] };
    await expect(adapter().clone(PROJECT_ID, url, 'main', { ssh })).resolves.toMatchObject({
      commit: expect.stringMatching(/^[\da-f]{40}$/),
    });
  });

  it('accepts the server when one of several trusted host keys matches', async () => {
    await expect(
      adapter().inspectRemote(url, 'main', {
        ssh: {
          privateKey: deployKey.privateKey,
          hostKeys: [otherHostKey.publicKey, hostKey.publicKey],
        },
      }),
    ).resolves.toMatchObject({ branchExists: true });
  });

  it('fails with host_key_mismatch when the server presents another host key', async () => {
    await expect(
      adapter().inspectRemote(url, 'main', { ssh: credentials(deployKey, otherHostKey) }),
    ).rejects.toMatchObject({ reason: 'host_key_mismatch' });
  });

  it('connects ssh and ssh-keyscan to the checked address of the host name (Issue #69)', async () => {
    // A name no DNS server knows: only the pinned address (HostName) leads to the container.
    const name = 'git.studio-fixture.test';
    const { address } = await lookup(container.getHost(), { family: 4 });
    const pinned = adapter({ resolveHost: async (host) => (host === name ? [address] : []) });
    const named = url.replace(`@${container.getHost()}:`, `@${name}:`);

    await expect(pinned.scanHostKey(named)).resolves.toEqual({ hostKey: hostKey.publicKey });
    await expect(
      pinned.inspectRemote(named, 'main', { ssh: credentials(deployKey, hostKey) }),
    ).resolves.toMatchObject({ branchExists: true });
    await expect(
      adapter({ allowPrivateRemotes: false, resolveHost: async () => [address] }).inspectRemote(
        named,
        'main',
        { ssh: credentials(deployKey, hostKey) },
      ),
    ).rejects.toMatchObject({ reason: 'remote_not_allowed' });
  });
});
