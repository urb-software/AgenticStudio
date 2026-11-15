// A runner that starts its CLI itself instead of through the spawn boundary.
import { spawn } from 'node:child_process';

export const start = () => spawn('claude', ['--print'], { shell: false });
