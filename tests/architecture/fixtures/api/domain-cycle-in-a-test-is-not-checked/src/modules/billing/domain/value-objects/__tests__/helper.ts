import type { sample } from './money.test.js';

export const helper = (): { amount: number } => ({ amount: 1 }) satisfies Partial<typeof sample>;
