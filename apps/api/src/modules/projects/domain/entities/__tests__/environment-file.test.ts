import { describe, expect, it } from 'vitest';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { EnvironmentFile } from '../environment-file.js';

const STORED: RestoreData<typeof EnvironmentFile> = {
  projectId: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  path: '.env',
  sizeBytes: 60,
  updatedAt: new Date('2026-11-15T10:00:00.000Z'),
  secretRef: '8d0f7780-8536-41ef-a4aa-5aa1b7e0c3ab',
};

describe('EnvironmentFile', () => {
  it('is restored from what the store holds and keeps the reference to its content', () => {
    const file = EnvironmentFile.restore(STORED);

    expect(file).toMatchObject(STORED);
  });
});
