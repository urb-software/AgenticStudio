import { createDatabaseClient } from '@agentic-studio/database';

export const testClient = createDatabaseClient('postgres://localhost/test');
