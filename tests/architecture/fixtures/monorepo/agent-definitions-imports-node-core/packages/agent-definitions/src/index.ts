import { readFileSync } from 'node:fs';

export const check = (path: string) => readFileSync(path, 'utf8');
