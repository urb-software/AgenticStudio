import { createRequire } from 'node:module';

export const load = (name: string) => createRequire(import.meta.url)(name);
