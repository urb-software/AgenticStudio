import { readFileSync } from 'node:fs';
import { check } from '../index.js';

export const run = () => check(readFileSync('x', 'utf8'));
