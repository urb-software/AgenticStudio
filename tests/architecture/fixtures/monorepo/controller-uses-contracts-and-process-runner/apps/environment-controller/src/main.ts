import { readFileSync } from 'node:fs';
import { validateCompose } from '@agentic-studio/compose-validation';
import { operationPayloadSchema } from '@agentic-studio/contracts';
import { parse } from 'yaml';
import { z } from 'zod';
import { run } from './process-runner.js';

export const load = (path: string) => [
  validateCompose(readFileSync(path, 'utf8')),
  operationPayloadSchema.parse(parse('a: 1')),
  z.string(),
  run,
];
