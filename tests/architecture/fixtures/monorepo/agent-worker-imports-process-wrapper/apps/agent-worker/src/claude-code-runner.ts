// A runner that starts its CLI through a process wrapper instead of the spawn boundary.
import { execa } from 'execa';

export const start = () => execa('claude', ['--print']);
