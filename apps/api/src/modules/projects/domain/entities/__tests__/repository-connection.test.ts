import { describe, expect, it } from 'vitest';
import { DeployKey } from '../../value-objects/deploy-key.js';
import { HostKey } from '../../value-objects/host-key.js';
import { RepositoryFailure } from '../../value-objects/repository-failure.js';
import { type ConnectAttempt } from '../repository-connection-facts.js';
import {
  HostKeyFingerprintMismatchError,
  NoUsableCloneError,
  RepositoryAlreadyConnectedError,
  RepositoryBusyError,
  RepositoryNotVerifiableError,
} from '../../errors/repository-connection-errors.js';
import { RepositoryConnection } from '../repository-connection.js';
import { type StoredRepositoryConnection } from '../repository-connection-snapshot.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const AT = new Date('2026-11-13T10:00:00.000Z');
const FAILURE = RepositoryFailure.of('host_unreachable', 'fatal: x');
const hostKey = (): string => DeployKey.generate('host').publicKey.split(' ').slice(0, 2).join(' ');
const DEPLOY_KEY = { publicKey: 'ssh-ed25519 AAAA studio', secretRef: 'secret-1' };

const attempt = (overrides: Partial<ConnectAttempt> = {}): ConnectAttempt => ({
  projectId: PROJECT,
  url: 'https://github.com/acme/shop.git',
  identity: 'github.com/acme/shop',
  integrationBranch: 'dev',
  ...overrides,
});

const stored = (overrides: Partial<StoredRepositoryConnection>): StoredRepositoryConnection => ({
  projectId: PROJECT,
  url: 'https://github.com/acme/shop.git',
  integrationBranch: 'dev',
  state: 'connecting',
  headSha: null,
  lastFetchedAt: null,
  failure: null,
  publicKey: null,
  deployKeySecret: null,
  pinnedHostKey: null,
  pendingHostKey: null,
  ...overrides,
});

const sshStored = (overrides: Partial<StoredRepositoryConnection>) =>
  stored({
    url: 'git@github.com:acme/shop.git',
    publicKey: DEPLOY_KEY.publicKey,
    deployKeySecret: DEPLOY_KEY.secretRef,
    ...overrides,
  });
const clone = { headSha: SHA, lastFetchedAt: AT };

const restore = (data: StoredRepositoryConnection) => RepositoryConnection.restore(data);
const ready = () => restore(stored({ state: 'ready', ...clone }));
const failedWithClone = () => restore(stored({ state: 'failed', ...clone, failure: FAILURE }));
const failedWithoutClone = () => restore(stored({ state: 'failed', failure: FAILURE }));
const failedSsh = () => restore(sshStored({ state: 'failed', failure: FAILURE }));
const awaitingKey = () => restore(sshStored({ state: 'awaiting_key' }));
const awaitingHostKey = (pending = hostKey()) =>
  restore(sshStored({ state: 'awaiting_host_key', pendingHostKey: pending }));
const fetching = () => restore(stored({ state: 'fetching', ...clone }));

describe('RepositoryConnection', () => {
  describe('start', () => {
    it('starts connecting without a Deploy key, with nothing cloned', () => {
      const repository = RepositoryConnection.start(attempt());

      expect(repository).toEqual({
        projectId: PROJECT,
        url: 'https://github.com/acme/shop.git',
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
      });
      expect(repository.pendingChanges().identity).toBe('github.com/acme/shop');
    });

    it('starts awaiting its key with a Deploy key, keeping a given pinned host key', () => {
      const pinned = hostKey();

      const repository = RepositoryConnection.start(
        attempt({ deployKey: DEPLOY_KEY, pinnedHostKey: pinned }),
      );

      expect(repository).toMatchObject({
        state: 'awaiting_key',
        publicKey: DEPLOY_KEY.publicKey,
        deployKeySecret: DEPLOY_KEY.secretRef,
        pinnedHostKey: pinned,
        hostKeyFingerprint: HostKey.of(pinned).fingerprint,
      });
    });

    it('never pins a host key without a Deploy key', () => {
      expect(RepositoryConnection.start(attempt({ pinnedHostKey: hostKey() })).pinnedHostKey).toBe(
        null,
      );
    });

    it('refuses a kept Deploy key: it belongs to a Repository that must exist', () => {
      expect(() => RepositoryConnection.start(attempt({ keepsDeployKey: true }))).toThrow(
        RepositoryAlreadyConnectedError,
      );
    });
  });

  describe('restore', () => {
    it.each([
      ['an unknown state', stored({ state: 'gone' as never })],
      ['a failed Repository without a failure', stored({ state: 'failed' })],
      ['a failure on a Repository that is not failed', stored({ failure: FAILURE })],
      ['a commit without a fetch time', stored({ state: 'ready', headSha: SHA })],
      ['a ready Repository without a Clone', stored({ state: 'ready' })],
      ['a connecting Repository with a Clone', stored(clone)],
      ['a public key without its secret', stored({ publicKey: 'ssh-ed25519 AAAA' })],
      ['an awaiting_key Repository without a Deploy key', stored({ state: 'awaiting_key' })],
      ['a pinned host key without a Deploy key', stored({ pinnedHostKey: hostKey() })],
      [
        'an awaiting_host_key Repository without a host key',
        sshStored({ state: 'awaiting_host_key' }),
      ],
      [
        'a host key awaiting confirmation in another state',
        sshStored({ pendingHostKey: hostKey() }),
      ],
    ])('refuses %s', (_case, data) => {
      expect(() => restore(data)).toThrow(TypeError);
    });

    it('derives the Clone flag and the fingerprint of the pending, else the pinned host key', () => {
      const pending = hostKey();
      const pinned = hostKey();

      const awaiting = restore(
        sshStored({ state: 'awaiting_host_key', pendingHostKey: pending, pinnedHostKey: pinned }),
      );

      expect(awaiting.hostKeyFingerprint).toBe(HostKey.of(pending).fingerprint);
      expect(ready().hasClone).toBe(true);
      expect(restore(sshStored({ pinnedHostKey: pinned })).hostKeyFingerprint).toBe(
        HostKey.of(pinned).fingerprint,
      );
    });

    it('starts with no pending changes', () => {
      expect(ready().pendingChanges()).toEqual({ fields: {} });
    });
  });

  describe('restart (a Retry)', () => {
    it('replaces a failed Repository with the new attempt and its identity', () => {
      const repository = failedWithClone();

      repository.restart(attempt({ url: 'https://github.com/acme/other.git', identity: 'other' }));

      expect(repository).toMatchObject({
        state: 'connecting',
        url: 'https://github.com/acme/other.git',
        hasClone: false,
        headSha: null,
        failure: null,
      });
      expect(repository.pendingChanges().identity).toBe('other');
    });

    it.each([
      ['connecting', stored({})],
      ['ready', stored({ state: 'ready', ...clone })],
      ['disconnecting', stored({ state: 'disconnecting' })],
    ])('refuses a %s Repository', (_case, data) => {
      expect(() => restore(data).restart(attempt())).toThrow(RepositoryAlreadyConnectedError);
    });

    it('keeps the Deploy key only while the Repository still references it', () => {
      const kept = failedSsh();
      kept.restart(attempt({ deployKey: DEPLOY_KEY, keepsDeployKey: true }));
      expect(kept).toMatchObject({ state: 'awaiting_key', deployKeySecret: 'secret-1' });

      const otherKey = { ...DEPLOY_KEY, secretRef: 'secret-2' };
      expect(() =>
        failedSsh().restart(attempt({ deployKey: otherKey, keepsDeployKey: true })),
      ).toThrow(RepositoryAlreadyConnectedError);
      expect(() =>
        failedWithoutClone().restart(attempt({ deployKey: DEPLOY_KEY, keepsDeployKey: true })),
      ).toThrow(RepositoryAlreadyConnectedError);
    });
  });

  describe('what a Retry keeps', () => {
    it('names the Deploy key of a failed SSH Repository only', () => {
      expect(failedSsh().retainedDeployKey).toEqual({
        secretRef: 'secret-1',
        publicKey: DEPLOY_KEY.publicKey,
      });
      expect(awaitingKey().retainedDeployKey).toBeNull();
      expect(failedWithoutClone().retainedDeployKey).toBeNull();
    });

    it('keeps a pinned host key for the same Git host only', () => {
      const pinned = hostKey();
      const repository = restore(
        sshStored({ state: 'failed', failure: FAILURE, pinnedHostKey: pinned }),
      );

      expect(repository.pinnedHostKeyFor('git@github.com:acme/other.git')).toBe(pinned);
      expect(repository.pinnedHostKeyFor('git@gitlab.com:acme/shop.git')).toBeNull();
      expect(repository.pinnedHostKeyFor('https://github.com/acme/shop.git')).toBeNull();
    });

    it('records the failed Repository own failure when a clone cannot be scheduled for the same attempt', () => {
      const previous = failedWithoutClone();
      const same = { url: previous.url, integrationBranch: previous.integrationBranch };

      expect(RepositoryConnection.failureWhenCloneNotScheduled(previous, same)).toBe(FAILURE);
      expect(RepositoryConnection.failureWhenCloneNotScheduled(previous)).toBe(FAILURE);
      const others = [
        RepositoryConnection.failureWhenCloneNotScheduled(previous, {
          ...same,
          integrationBranch: 'x',
        }),
        RepositoryConnection.failureWhenCloneNotScheduled(ready()),
        RepositoryConnection.failureWhenCloneNotScheduled(null, same),
      ];
      for (const other of others) expect(other).toEqual(RepositoryFailure.notStarted());
    });
  });

  describe('verification', () => {
    it.each([
      ['awaiting_key', awaitingKey()],
      ['awaiting_host_key', awaitingHostKey()],
      ['failed without a Clone', failedSsh()],
    ])('is possible for an SSH Repository that is %s', (_case, repository) => {
      expect(repository.isVerifiable).toBe(true);
      expect(() => repository.assertVerifiable()).not.toThrow();
    });

    it.each([
      ['an HTTPS Repository', failedWithoutClone()],
      ['a connecting SSH Repository', restore(sshStored({}))],
      ['an SSH Repository with a Clone', restore(sshStored({ state: 'ready', ...clone }))],
    ])('is refused for %s', (_case, repository) => {
      expect(repository.isVerifiable).toBe(false);
      expect(() => repository.assertVerifiable()).toThrow(RepositoryNotVerifiableError);
      expect(() => repository.awaitHostKey(hostKey())).toThrow(RepositoryNotVerifiableError);
      expect(() => repository.startVerifiedClone(null)).toThrow(RepositoryNotVerifiableError);
      expect(repository.failVerification(FAILURE)).toBe(false);
      expect(repository.pendingChanges().fields).toEqual({});
    });

    it('awaits the retrieved host key and clears the failure', () => {
      const repository = failedSsh();
      const key = hostKey();

      repository.awaitHostKey(key);

      expect(repository).toMatchObject({
        state: 'awaiting_host_key',
        pendingHostKey: key,
        failure: null,
        hostKeyFingerprint: HostKey.of(key).fingerprint,
      });
    });

    it('fails verification when the host cannot be reached', () => {
      const repository = awaitingHostKey();

      expect(repository.failVerification(FAILURE)).toBe(true);

      expect(repository).toMatchObject({ state: 'failed', failure: FAILURE, pendingHostKey: null });
    });

    it('starts the clone of a trusted host from any verifiable state, clearing the failure', () => {
      const repository = failedSsh();

      repository.startVerifiedClone(null);

      expect(repository).toMatchObject({
        state: 'connecting',
        failure: null,
        pendingHostKey: null,
      });
    });

    describe('confirming the host key', () => {
      const pending = hostKey();

      it('pins exactly the key the operator saw, and starts the clone', () => {
        const repository = awaitingHostKey(pending);
        const confirmed = repository.confirmedHostKey(HostKey.of(pending).fingerprint);

        repository.startVerifiedClone({ pendingHostKey: confirmed });

        expect(repository).toMatchObject({
          state: 'connecting',
          pinnedHostKey: pending,
          pendingHostKey: null,
        });
      });

      it('refuses another fingerprint, and a confirmation while no host key awaits it', () => {
        expect(() =>
          awaitingHostKey(pending).confirmedHostKey(HostKey.of(hostKey()).fingerprint),
        ).toThrow(HostKeyFingerprintMismatchError);
        expect(() => awaitingKey().confirmedHostKey('SHA256:x')).toThrow(
          RepositoryNotVerifiableError,
        );
      });

      it('refuses to pin a key that is not the pending one any more', () => {
        expect(() =>
          awaitingHostKey(pending).startVerifiedClone({ pendingHostKey: hostKey() }),
        ).toThrow(RepositoryNotVerifiableError);
        expect(() => awaitingKey().startVerifiedClone({ pendingHostKey: pending })).toThrow(
          RepositoryNotVerifiableError,
        );
      });
    });
  });

  describe('the clone', () => {
    it('completes: connecting → ready with the commit, once', () => {
      const repository = restore(stored({}));

      expect(repository.completeClone({ headSha: SHA, fetchedAt: AT })).toBe(true);

      expect(repository).toMatchObject({
        state: 'ready',
        hasClone: true,
        headSha: SHA,
        lastFetchedAt: AT,
      });
      expect(repository.completeClone({ headSha: NEW_SHA, fetchedAt: AT })).toBe(false);
      expect(repository.headSha).toBe(SHA);
    });

    it('fails: connecting → failed, once', () => {
      const repository = restore(stored({}));

      expect(repository.failClone(FAILURE)).toBe(true);
      expect(repository).toMatchObject({ state: 'failed', failure: FAILURE, hasClone: false });
      expect(repository.failClone(RepositoryFailure.of('timeout'))).toBe(false);
      expect(repository.failure).toBe(FAILURE);
    });

    it.each([
      ['ready', ready()],
      ['fetching', fetching()],
      ['disconnecting', restore(stored({ state: 'disconnecting' }))],
    ])('changes nothing for a late report on a %s Repository', (_case, repository) => {
      expect(repository.completeClone({ headSha: NEW_SHA, fetchedAt: AT })).toBe(false);
      expect(repository.failClone(FAILURE)).toBe(false);
      expect(repository.pendingChanges().fields).toEqual({});
    });
  });

  describe('the fetch', () => {
    it.each([
      ['ready', ready()],
      ['failed with a usable Clone', failedWithClone()],
    ])('starts from %s, clearing the failure and keeping the Clone', (_case, repository) => {
      repository.startFetch();

      expect(repository).toMatchObject({
        state: 'fetching',
        failure: null,
        headSha: SHA,
        lastFetchedAt: AT,
      });
    });

    it('refuses a failed Repository without a Clone', () => {
      expect(() => failedWithoutClone().startFetch()).toThrow(NoUsableCloneError);
    });

    it.each([
      ['connecting', stored({})],
      ['fetching', stored({ state: 'fetching', ...clone })],
      ['awaiting_key', sshStored({ state: 'awaiting_key' })],
      ['disconnecting', stored({ state: 'disconnecting' })],
    ])('refuses a %s Repository as busy', (_case, data) => {
      expect(() => restore(data).startFetch()).toThrow(RepositoryBusyError);
    });

    it('completes with the new commit', () => {
      const repository = fetching();

      expect(repository.completeFetch({ headSha: NEW_SHA, fetchedAt: AT })).toBe(true);

      expect(repository).toMatchObject({ state: 'ready', headSha: NEW_SHA });
      expect(repository.completeFetch({ headSha: SHA, fetchedAt: AT })).toBe(false);
    });

    it('fails keeping the Clone, or without it when the Clone was removed', () => {
      const kept = fetching();
      expect(kept.failFetch(FAILURE, { cloneKept: true })).toBe(true);
      expect(kept).toMatchObject({ state: 'failed', hasClone: true, headSha: SHA });

      const removed = fetching();
      expect(removed.failFetch(FAILURE, { cloneKept: false })).toBe(true);
      expect(removed).toMatchObject({
        state: 'failed',
        hasClone: false,
        headSha: null,
        lastFetchedAt: null,
      });
      expect(removed.failFetch(FAILURE, { cloneKept: true })).toBe(false);
    });

    it('goes back to what it was when the fetch could not be scheduled', () => {
      const wasReady = fetching();
      expect(wasReady.revertFetch(null)).toBe(true);
      expect(wasReady).toMatchObject({ state: 'ready', headSha: SHA, lastFetchedAt: AT });

      const wasFailed = fetching();
      expect(wasFailed.revertFetch(FAILURE)).toBe(true);
      expect(wasFailed).toMatchObject({ state: 'failed', failure: FAILURE, headSha: SHA });

      expect(ready().revertFetch(null)).toBe(false);
    });

    it('changes nothing for a late report on a Repository that is not fetching', () => {
      const repository = ready();
      expect(repository.completeFetch({ headSha: NEW_SHA, fetchedAt: AT })).toBe(false);
      expect(repository.failFetch(FAILURE, { cloneKept: true })).toBe(false);
      expect(repository.pendingChanges().fields).toEqual({});
    });
  });

  describe('disconnecting', () => {
    it.each([
      ['connecting', stored({})],
      ['ready', stored({ state: 'ready', ...clone })],
      ['failed', stored({ state: 'failed', failure: FAILURE })],
    ])('moves a %s Repository to disconnecting, dropping its failure and Clone', (_case, data) => {
      const repository = restore(data);

      repository.startDisconnect();

      expect(repository).toMatchObject({
        state: 'disconnecting',
        failure: null,
        hasClone: false,
        headSha: null,
        lastFetchedAt: null,
      });
      expect(repository.isDisconnecting).toBe(true);
    });

    it('drops a pending host key but keeps the Deploy key until it is forgotten', () => {
      const repository = restore(
        sshStored({
          state: 'awaiting_host_key',
          pendingHostKey: hostKey(),
          pinnedHostKey: hostKey(),
        }),
      );

      repository.startDisconnect();
      expect(repository).toMatchObject({ pendingHostKey: null, deployKeySecret: 'secret-1' });
      expect(repository.holdsDeployKeyMaterial).toBe(true);

      expect(repository.forgetDeployKey()).toBe(true);
      expect(repository).toMatchObject({
        publicKey: null,
        deployKeySecret: null,
        pinnedHostKey: null,
      });
      expect(repository.holdsDeployKeyMaterial).toBe(false);
    });

    it('is repeatable, and removes the record only when disconnecting', () => {
      const repository = ready();
      expect(repository.forgetDeployKey()).toBe(false);
      expect(repository.finishDisconnect()).toBe(false);
      expect(repository.pendingChanges().removed).toBeUndefined();

      repository.startDisconnect();
      repository.startDisconnect();
      expect(repository.finishDisconnect()).toBe(true);
      expect(repository.pendingChanges().removed).toBe(true);
    });

    it('says which job runs for its state', () => {
      expect(restore(stored({})).pendingOperation).toBe('clone');
      expect(fetching().pendingOperation).toBe('fetch');
      expect(ready().pendingOperation).toBeNull();
    });
  });

  it('records exactly the fields a transition changed, never the derived ones', () => {
    const repository = restore(stored({}));

    repository.completeClone({ headSha: SHA, fetchedAt: AT });

    expect(repository.pendingChanges().fields).toEqual({
      state: 'ready',
      headSha: SHA,
      lastFetchedAt: AT,
      failure: null,
    });
  });
});
