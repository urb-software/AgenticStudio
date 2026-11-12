import { createDatabaseClient } from '../../../packages/database/src/index';

export const client = createDatabaseClient('postgres://localhost/studio');
