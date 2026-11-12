import { createDatabaseClient } from '@agentic-studio/database';
import { projectDraft } from '@/modules/projects/store';

export const client = { db: createDatabaseClient('postgres://localhost/studio'), projectDraft };
