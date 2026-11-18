import type { RepositoryConnectionData } from './repository-connection-data.js';

/**
 * A Repository's current values as read-only plain data: what a handler returns of it. It
 * carries the aggregate's own id (`projectId`: a Repository is identified by its Project) and,
 * as today, the Deploy key's secret reference, which handler tests read from the
 * result (connect, disconnect and verify `handler.test.ts`); the HTTP mapper (`toRepositoryResponse`) drops it, so no response shows it.
 */
export type RepositoryConnectionSnapshot = Readonly<RepositoryConnectionData>;
