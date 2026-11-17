/**
 * The states of a Repository: the last operation, not whether a Clone exists (see
 * `RepositoryConnection.hasClone`). An SSH Repository starts in `awaiting_key`: its Deploy key
 * still has to be added on the Git host, then verified (Issue #62); `awaiting_host_key`: the
 * Git host is not trusted yet and the operator has to confirm its host key. `connecting`: the
 * first Clone is being made; `ready`: the Clone is up to date as of the last fetch; `fetching`:
 * the Clone is being brought up to date; `failed`: the last connect or fetch failed;
 * `disconnecting`: the operator disconnected it and its data is still being removed (the record
 * goes last). Which operation each state accepts is owned by `RepositoryLifecycle`.
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

/** Whether `value` is one of the {@link REPOSITORY_STATES}. */
export function isRepositoryState(value: string): value is RepositoryState {
  return (REPOSITORY_STATES as readonly string[]).includes(value);
}
