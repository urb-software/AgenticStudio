import { execFile } from 'node:child_process';

export const quick = () => execFile('docker', ['ps']);
