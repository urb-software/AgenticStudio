import type { RepositoryState } from './repository-state.js';
import type { RepositoryFailure } from './repository-failure.js';

export interface StorableConnection {
  state: RepositoryState;
  headSha: string | null;
  lastFetchedAt: Date | null;
  failure: RepositoryFailure | null;
  publicKey: string | null;
  deployKeySecret: string | null;
  pinnedHostKey: string | null;
  pendingHostKey: string | null;
}
