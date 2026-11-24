import { execa } from 'execa';

export const run = () => execa('docker', ['info']);
