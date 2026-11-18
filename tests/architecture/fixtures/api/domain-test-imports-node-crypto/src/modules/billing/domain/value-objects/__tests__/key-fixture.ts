import { randomBytes } from 'node:crypto';

export const fixtureKey = randomBytes(4).toString('hex');
