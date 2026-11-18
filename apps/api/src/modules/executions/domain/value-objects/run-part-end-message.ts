import type { RunPartEnd } from './run-part-end.js';

export type RunPartEndMessage = { kind: 'part_end'; at: Date } & RunPartEnd;
