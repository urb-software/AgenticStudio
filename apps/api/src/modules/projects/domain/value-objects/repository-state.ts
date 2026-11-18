/**
 * The states of a Repository: the last operation, not whether a Clone exists (see
 * `RepositoryConnection.hasClone`). `RepositoryLifecycle` owns which operation each state accepts.
 */
export const REPOSITORY_STATES = [
  'awaiting_key',
  'awaiting_host_key',
  'connecting',
  'ready',
  'fetching',
  'failed',
  'disconnecting',
] as const;
export type RepositoryState = (typeof REPOSITORY_STATES)[number];

export function isRepositoryState(value: string): value is RepositoryState {
  return (REPOSITORY_STATES as readonly string[]).includes(value);
}
