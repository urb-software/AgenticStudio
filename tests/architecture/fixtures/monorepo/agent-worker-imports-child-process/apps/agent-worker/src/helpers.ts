import { execFile } from 'child_process';

export const run = (command: string) => execFile(command);
