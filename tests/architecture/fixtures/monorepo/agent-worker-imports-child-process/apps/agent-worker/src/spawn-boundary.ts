import { spawn } from 'node:child_process';

export const spawnProviderCli = (command: string) => spawn(command, [], { shell: false });
