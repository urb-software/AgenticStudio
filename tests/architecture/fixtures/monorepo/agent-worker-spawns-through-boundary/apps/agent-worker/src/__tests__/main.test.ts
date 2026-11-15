import { spawnSync } from 'node:child_process';
import { start } from '../main.js';

export const check = () => [start(), spawnSync('node', ['--version'])];
