import { describe, expect, it } from 'vitest';
import { NoUsableCloneError, RepositoryBusyError } from '../repository-connection-errors.js';
import type { StoredRepositoryConnection } from '../repository-connection-snapshot.js';
import { RepositoryFailure } from '../repository-failure.js';
import { RepositoryLifecycle } from '../repository-lifecycle.js';
import { REPOSITORY_STATES, type RepositoryState } from '../repository-state.js';

const lifecycle = (state: RepositoryState, hasClone = false, hasDeployKey = false) =>
  RepositoryLifecycle.of({ state, hasClone, hasDeployKey });

const only = (state: RepositoryState, ...accepting: RepositoryState[]) => accepting.includes(state);

describe('RepositoryLifecycle', () => {
  it('starts in awaiting_key with a Deploy key and in connecting without one', () => {
    expect(RepositoryLifecycle.initialState(true)).toBe('awaiting_key');
    expect(RepositoryLifecycle.initialState(false)).toBe('connecting');
  });

  it.each(REPOSITORY_STATES)('%s accepts exactly the operations of its state', (state) => {
    const current = lifecycle(state);
    expect(current.acceptsCloneResult).toBe(only(state, 'connecting'));
    expect(current.acceptsFetchResult).toBe(only(state, 'fetching'));
    expect(current.acceptsCleanup).toBe(only(state, 'disconnecting'));
    expect(current.acceptsRetry).toBe(only(state, 'failed'));
    expect(current.isFailed).toBe(only(state, 'failed'));
    expect(current.isDisconnecting).toBe(only(state, 'disconnecting'));
    expect(current.isAwaitingHostKey).toBe(only(state, 'awaiting_host_key'));
  });

  it('runs a clone job while connecting and a fetch job while fetching, nothing otherwise', () => {
    expect(lifecycle('connecting').pendingOperation).toBe('clone');
    expect(lifecycle('fetching', true).pendingOperation).toBe('fetch');
    for (const state of REPOSITORY_STATES.filter((s) => s !== 'connecting' && s !== 'fetching')) {
      expect(lifecycle(state).pendingOperation).toBeNull();
    }
  });

  describe('isVerifiable', () => {
    it.each(['awaiting_key', 'awaiting_host_key', 'failed'] as const)(
      'is true for an SSH Repository without a Clone that is %s',
      (state) => {
        expect(lifecycle(state, false, true).isVerifiable).toBe(true);
      },
    );

    it('is false without a Deploy key, with a Clone, or in another state', () => {
      expect(lifecycle('awaiting_key', false, false).isVerifiable).toBe(false);
      expect(lifecycle('failed', true, true).isVerifiable).toBe(false);
      for (const state of ['connecting', 'ready', 'fetching', 'disconnecting'] as const) {
        expect(lifecycle(state, false, true).isVerifiable).toBe(false);
      }
    });
  });

  describe('fetchRefusal', () => {
    it('allows a fetch from ready and from failed with a usable Clone', () => {
      expect(lifecycle('ready', true).fetchRefusal()).toBeNull();
      expect(lifecycle('failed', true).fetchRefusal()).toBeNull();
    });

    it('refuses a failed Repository without a Clone: no usable Clone', () => {
      expect(lifecycle('failed', false).fetchRefusal()).toBeInstanceOf(NoUsableCloneError);
    });

    it.each([
      'connecting',
      'fetching',
      'awaiting_key',
      'awaiting_host_key',
      'disconnecting',
    ] as const)('refuses %s as busy', (state) => {
      expect(lifecycle(state).fetchRefusal()).toBeInstanceOf(RepositoryBusyError);
    });
  });

  describe('assertStorable', () => {
    const stored = (
      overrides: Partial<StoredRepositoryConnection>,
    ): StoredRepositoryConnection => ({
      projectId: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
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
    const clone = { headSha: 'a'.repeat(40), lastFetchedAt: new Date('2026-11-13T10:00:00Z') };
    const failure = RepositoryFailure.of('host_unreachable', 'fatal: x');

    it('accepts the combinations a store holds', () => {
      expect(() => RepositoryLifecycle.assertStorable(stored({}))).not.toThrow();
      expect(() =>
        RepositoryLifecycle.assertStorable(stored({ state: 'ready', ...clone })),
      ).not.toThrow();
      expect(() =>
        RepositoryLifecycle.assertStorable(stored({ state: 'failed', failure })),
      ).not.toThrow();
    });

    it.each([
      ['an unknown state', { state: 'gone' as RepositoryState }],
      ['a failed Repository without a failure', { state: 'failed' as const }],
      ['a failure outside failed', { failure }],
      ['a commit without a fetch time', { headSha: 'a'.repeat(40) }],
      ['a ready Repository without a Clone', { state: 'ready' as const }],
      ['a connecting Repository with a Clone', { ...clone }],
      ['a public key without its reference', { publicKey: 'ssh-ed25519 AAAA studio' }],
      ['a pinned host key without a Deploy key', { pinnedHostKey: 'ssh-ed25519 AAAA' }],
      ['awaiting_key without a Deploy key', { state: 'awaiting_key' as const }],
      ['a pending host key outside awaiting_host_key', { pendingHostKey: 'ssh-ed25519 AAAA' }],
    ])('refuses %s', (_case, overrides) => {
      expect(() => RepositoryLifecycle.assertStorable(stored(overrides))).toThrow(TypeError);
    });
  });
});
