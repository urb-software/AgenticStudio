import { createDatabaseClient } from '@agentic-studio/database';
import { startPostgres } from '@agentic-studio/testing';
import { load } from '../main.js';

export const setup = async () => [load('x'), createDatabaseClient((await startPostgres()).url)];
