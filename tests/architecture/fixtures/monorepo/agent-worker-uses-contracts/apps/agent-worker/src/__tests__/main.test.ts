import { startPostgres } from '@agentic-studio/testing';
import { parse } from '../main.js';

export const setup = async () => parse(await startPostgres());
