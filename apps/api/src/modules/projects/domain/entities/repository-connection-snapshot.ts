import type { RepositoryConnectionData } from './repository-connection-data.js';

/**
 * A Repository's current values as read-only plain data. It carries the Deploy key's secret
 * reference, which handler tests read; the HTTP mapper drops it.
 */
export type RepositoryConnectionSnapshot = Readonly<RepositoryConnectionData>;
