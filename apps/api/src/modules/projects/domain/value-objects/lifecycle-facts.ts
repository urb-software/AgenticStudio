import type { RepositoryState } from './repository-state.js';

export interface LifecycleFacts {
  readonly state: RepositoryState;
  readonly hasClone: boolean;
  readonly hasDeployKey: boolean;
}
