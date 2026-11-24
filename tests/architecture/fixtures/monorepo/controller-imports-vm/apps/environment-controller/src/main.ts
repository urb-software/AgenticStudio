import { runInThisContext } from 'node:vm';

export const load = (code: string) => runInThisContext(code);
