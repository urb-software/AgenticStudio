import { runInThisContext } from 'node:vm';

// Runs code the dependency graph cannot see.
export const load = (code: string) => runInThisContext(code) as unknown;
