import { afterAll } from 'vitest';
import { removeCreatedDataDirs } from './test-config.js';

// Runs in every test file's module instance, so each file removes the directories it created.
afterAll(async () => {
  await removeCreatedDataDirs();
});
