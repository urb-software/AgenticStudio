import { describe, expect, it } from 'vitest';
import { EnvironmentFile } from '../../domain/entities/environment-file.js';
import { type RestoreData } from '../../../../__tests__/restore-data.js';
import { environmentFileView } from '../environment-file-view.js';

const STORED: RestoreData<typeof EnvironmentFile> = {
  projectId: '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  path: '.env',
  sizeBytes: 60,
  updatedAt: new Date('2026-11-15T10:00:00.000Z'),
  secretRef: '8d0f7780-8536-41ef-a4aa-5aa1b7e0c3ab',
};

describe('environmentFileView', () => {
  it('shows the operator only the path, the size and the last change', () => {
    const view = environmentFileView(EnvironmentFile.restore(STORED));

    expect(view).toEqual({ path: '.env', sizeBytes: 60, updatedAt: STORED.updatedAt });
    expect(JSON.stringify(view)).not.toContain(STORED.secretRef);
    expect(view).not.toBeInstanceOf(EnvironmentFile);
  });
});
