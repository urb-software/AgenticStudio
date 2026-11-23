import { describe, expect, it } from 'vitest';
import {
  previewRefusalCodeSchema,
  previewSchema,
  savePreviewSettingsRequestSchema,
  savePreviewSettingsResponseSchema,
} from '../index.js';

const REQUEST = { composeFile: 'compose.yaml', service: 'web', port: 3000 };

describe('preview contract', () => {
  it('accepts the three settings and nothing else', () => {
    expect(savePreviewSettingsRequestSchema.safeParse(REQUEST).success).toBe(true);
    expect(savePreviewSettingsRequestSchema.safeParse({ ...REQUEST, extra: 1 }).success).toBe(
      false,
    );
    expect(savePreviewSettingsRequestSchema.safeParse({ ...REQUEST, port: '3000' }).success).toBe(
      false,
    );
  });

  it('checks the shape of the service and the port', () => {
    for (const bad of [
      { service: '' },
      { service: '-web' },
      { service: 'a'.repeat(64) },
      { port: 0 },
      { port: 65536 },
      { port: 80.5 },
    ]) {
      expect(savePreviewSettingsRequestSchema.safeParse({ ...REQUEST, ...bad }).success).toBe(
        false,
      );
    }
    expect(
      savePreviewSettingsRequestSchema.safeParse({
        ...REQUEST,
        service: 'a'.repeat(63),
        port: 65535,
      }).success,
    ).toBe(true);
  });

  it('answers the settings or null, with the hostname or why there is none', () => {
    const repository = { ready: true };
    expect(previewSchema.safeParse({ settings: null, hostname: null, repository }).success).toBe(
      true,
    );
    expect(
      previewSchema.safeParse({
        settings: { ...REQUEST, updatedAt: '2026-11-23T10:00:00.000Z' },
        hostname: 'preview-0123456789ab.example.test',
        repository,
      }).success,
    ).toBe(true);
    expect(
      savePreviewSettingsResponseSchema.safeParse({
        settings: null,
        hostname: null,
        hostnameUnavailable: 'not_configured',
        repository,
        removedPorts: [{ service: 'web', place: 'services.web.ports[0]' }],
      }).success,
    ).toBe(true);
  });

  it('names the three refusals the settings flow adds', () => {
    for (const code of ['compose_file_missing', 'compose_file_too_large', 'invalid_path']) {
      expect(previewRefusalCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
