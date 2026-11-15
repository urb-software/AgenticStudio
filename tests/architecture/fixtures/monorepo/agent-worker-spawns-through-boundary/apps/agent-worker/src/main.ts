import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { spawnProviderCli } from './spawn-boundary.js';

export const id = z.uuid().parse(randomUUID());
export const start = () => spawnProviderCli('provider-cli');
