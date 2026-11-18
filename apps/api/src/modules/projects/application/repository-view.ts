import type { RepositoryConnection } from '../domain/entities/repository-connection.js';
import type { RepositoryFailureCode } from '../domain/value-objects/repository-failure.js';
import type { RepositoryState } from '../domain/value-objects/repository-state.js';

/** A Repository as the operator sees it: no secret reference and no host key. */
export interface RepositoryView {
  state: RepositoryState;
  url: string;
  integrationBranch: string;
  hasClone: boolean;
  headSha: string | null;
  lastFetchedAt: Date | null;
  failure: {
    code: RepositoryFailureCode;
    detail: string;
    remoteDefaultBranch: string | null;
  } | null;
  /** SSH only: the public half of the Deploy key. */
  publicKey: string | null;
  hostKeyFingerprint: string | null;
}

export function repositoryView(repository: RepositoryConnection): RepositoryView {
  const { failure } = repository;
  return {
    state: repository.state,
    url: repository.url,
    integrationBranch: repository.integrationBranch,
    hasClone: repository.hasClone,
    headSha: repository.headSha,
    lastFetchedAt: repository.lastFetchedAt,
    failure: failure
      ? {
          code: failure.code,
          detail: failure.detail,
          remoteDefaultBranch: failure.remoteDefaultBranch,
        }
      : null,
    publicKey: repository.publicKey,
    hostKeyFingerprint: repository.hostKeyFingerprint,
  };
}
