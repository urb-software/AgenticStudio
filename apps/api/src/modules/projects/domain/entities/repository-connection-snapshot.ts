import type { RepositoryConnectionData } from './repository-connection-data.js';

/** A Repository's current values as read-only plain data, with the Deploy key's secret reference. */
export type RepositoryConnectionSnapshot = Readonly<RepositoryConnectionData>;
