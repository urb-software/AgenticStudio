import { spawn } from 'node:child_process';

export const runAll = () => spawn('docker', ['ps']);
