import { createDatabaseClient } from '@agentic-studio/database';

export const client = createDatabaseClient('postgres://localhost/studio');
