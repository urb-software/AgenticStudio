import { beforeEach, describe, expect, it } from 'vitest';
import { knownHostName } from '../../../../../platform/config/ssh-known-hosts.js';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import {
  NoTrustedHostKeyError,
  type RepositoryConnectionData,
} from '../../../domain/entities/repository.js';
import { generateDeployKey } from '../../../domain/value-objects/ssh-key.js';
import { gitHostName } from '../../../domain/value-objects/trusted-host-keys.js';
import { SecretStoreDeployKeys } from '../secret-store-deploy-keys.js';

const hostKey = (): string => generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');
const GITHUB_KEY = hostKey();
const PORT_KEY = hostKey();
const PINNED_KEY = hostKey();

function repository(overrides: Partial<RepositoryConnectionData>): RepositoryConnectionData {
  return {
    projectId: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
    url: 'git@github.com:acme/shop.git',
    integrationBranch: 'dev',
    state: 'connecting',
    hasClone: false,
    headSha: null,
    lastFetchedAt: null,
    failure: null,
    publicKey: null,
    deployKeySecret: null,
    pinnedHostKey: null,
    pendingHostKey: null,
    hostKeyFingerprint: null,
    ...overrides,
  };
}

describe('SecretStoreDeployKeys', () => {
  let secrets: InMemorySecretStore;
  let keys: SecretStoreDeployKeys;

  beforeEach(() => {
    secrets = new InMemorySecretStore();
    keys = new SecretStoreDeployKeys(secrets, {
      knownHosts: [
        { hosts: ['github.com'], key: GITHUB_KEY },
        { hosts: ['[git.example.com]:2222'], key: PORT_KEY },
      ],
    });
  });

  it('generates a Deploy key for the project; only the secret store holds the private half', async () => {
    const created = await keys.create('Acme Shop');

    expect(created.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* studio-Acme-Shop$/);
    expect(created).not.toHaveProperty('privateKey');
    const stored = await secrets.get(created.secretRef);
    expect(stored).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(JSON.stringify(created)).not.toContain('PRIVATE KEY');
  });

  it('stores the private half under the Deploy-key owner label (Issue #76)', async () => {
    const { secretRef } = await keys.create('Shop');

    expect(secrets.owners.get(secretRef)).toBe('projects.deploy-key');
  });

  it('deletes a Deploy key; deleting a missing one is a no-op', async () => {
    const { secretRef } = await keys.create('Shop');

    await keys.remove(secretRef);
    await keys.remove(secretRef);

    expect(secrets.values.size).toBe(0);
  });

  describe('trustedHostKeys', () => {
    it('applies the configured known hosts and the pinned key to the Repository', () => {
      expect(keys.trustedHostKeys(repository({})).keys).toEqual([GITHUB_KEY]);
      expect(
        keys.trustedHostKeys(repository({ url: 'ssh://git@git.example.com:2222/acme/shop.git' }))
          .keys,
      ).toEqual([PORT_KEY]);
      expect(keys.trustedHostKeys(repository({ pinnedHostKey: PINNED_KEY })).keys).toEqual([
        GITHUB_KEY,
        PINNED_KEY,
      ]);
      expect(
        keys.trustedHostKeys(repository({ url: 'git@gitlab.com:acme/shop.git' })).isEmpty,
      ).toBe(true);
    });

    it('names hosts the way the configuration does', () => {
      expect(gitHostName('git@GitHub.com:acme/shop.git')).toBe(knownHostName('GitHub.com', 22));
      expect(gitHostName('ssh://git@git.example.com:2222/a/b.git')).toBe(
        knownHostName('git.example.com', 2222),
      );
    });
  });

  it("lists the Deploy keys older than an age, never another owner's secrets", async () => {
    const { secretRef } = await keys.create('Shop');
    await secrets.put('another module value', { owner: 'agents.token' });
    secrets.now += 1000;

    await expect(keys.listOlderThan(1000)).resolves.toEqual([secretRef]);
    await expect(keys.listOlderThan(1001)).resolves.toEqual([]);
  });

  describe('credentials', () => {
    it('is undefined for a Repository without a Deploy key (HTTPS)', async () => {
      await expect(
        keys.credentials(repository({ url: 'https://github.com/acme/shop.git' })),
      ).resolves.toBeUndefined();
    });

    it('reads the private key from the secret store, with the trusted host keys', async () => {
      const { secretRef, publicKey } = await keys.create('Shop');

      const credentials = await keys.credentials(
        repository({ deployKeySecret: secretRef, publicKey, pinnedHostKey: PINNED_KEY }),
      );

      expect(credentials).toEqual({
        privateKey: await secrets.get(secretRef),
        hostKeys: [GITHUB_KEY, PINNED_KEY],
      });
    });

    it('refuses to connect when no host key is trusted', async () => {
      const { secretRef, publicKey } = await keys.create('Shop');

      await expect(
        keys.credentials(
          repository({
            url: 'git@gitlab.com:acme/shop.git',
            deployKeySecret: secretRef,
            publicKey,
          }),
        ),
      ).rejects.toBeInstanceOf(NoTrustedHostKeyError);
    });
  });
});
