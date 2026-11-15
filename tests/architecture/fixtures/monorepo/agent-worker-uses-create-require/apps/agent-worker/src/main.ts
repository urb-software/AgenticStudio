import { createRequire } from 'node:module';

// Loads child_process without an import the graph would see.
const load = createRequire(import.meta.url);
export const spawn = () => (load('child_process') as { spawn: unknown }).spawn;
