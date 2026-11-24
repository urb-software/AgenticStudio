import { describe, expect, it } from 'vitest';
import {
  PreviewBuildRunningError,
  PreviewRunningError,
} from '../../errors/preview-settings-errors.js';
import { PreviewComposeFile } from '../../value-objects/preview-compose-file.js';
import { PreviewPort } from '../../value-objects/preview-port.js';
import { PreviewService } from '../../value-objects/preview-service.js';
import type { PreviewSettingsRemovalFacts } from '../preview-settings-removal-facts.js';
import { PreviewSettings } from '../preview-settings.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

function settings(): PreviewSettings {
  return PreviewSettings.create({
    projectId: PROJECT,
    composeFile: PreviewComposeFile.of('deploy/compose.yaml'),
    service: PreviewService.of('web'),
    port: PreviewPort.of(3000),
    now: new Date('2026-11-23T10:00:00.000Z'),
  });
}

describe('PreviewSettings', () => {
  it('is made from validated values, and restored from its data', () => {
    const made = settings();

    expect(made).toMatchObject({
      projectId: PROJECT,
      composeFile: 'deploy/compose.yaml',
      service: 'web',
      port: 3000,
      updatedAt: new Date('2026-11-23T10:00:00.000Z'),
    });
    const { projectId, composeFile, service, port, updatedAt } = made;
    expect(PreviewSettings.restore({ projectId, composeFile, service, port, updatedAt })).toEqual(
      made,
    );
  });

  describe('remove', () => {
    const idle: PreviewSettingsRemovalFacts = { previewRunning: false, buildActive: false };
    const running: PreviewSettingsRemovalFacts = { previewRunning: true, buildActive: false };
    const building: PreviewSettingsRemovalFacts = { previewRunning: false, buildActive: true };

    it('allows removal while no Preview runs', () => {
      expect(() => settings().remove(idle)).not.toThrow();
    });

    it('refuses removal while the Preview runs', () => {
      expect(() => settings().remove(running)).toThrow(PreviewRunningError);
    });

    it('refuses removal while a build is requested or claimed', () => {
      expect(() => settings().remove(building)).toThrow(PreviewBuildRunningError);
    });

    it('names a running Preview before a running build', () => {
      expect(() => settings().remove({ previewRunning: true, buildActive: true })).toThrow(
        PreviewRunningError,
      );
    });
  });
});
