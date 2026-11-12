import { execFile } from 'node:child_process';

export function openRepository(path: string): void {
  execFile('git', ['status'], { cwd: path });
}
