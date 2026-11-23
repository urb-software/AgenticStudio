import { REFUSAL_CODES } from '@agentic-studio/compose-validation';
import {
  PREVIEW_COMPOSE_FILE_MAX_LENGTH,
  PREVIEW_REFUSAL_CODES,
  PREVIEW_SERVICE_MAX_LENGTH,
  PREVIEW_SERVICE_PATTERN,
  savePreviewSettingsRequestSchema,
} from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { PreviewComposeFile } from '../../../../domain/value-objects/preview-compose-file.js';
import { PreviewPort } from '../../../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../../../domain/value-objects/preview-service.js';

// The domain may not import the contract package and the contract may not import the validation
// package, so each list is pinned to the other here.
describe('the Preview contract and its sources', () => {
  it('lists every refusal code of the validation, and the three the settings flow adds', () => {
    expect([...PREVIEW_REFUSAL_CODES]).toEqual([
      ...REFUSAL_CODES,
      'compose_file_missing',
      'compose_file_too_large',
      'invalid_path',
    ]);
  });

  it('takes its limits from the domain', () => {
    expect(PREVIEW_COMPOSE_FILE_MAX_LENGTH).toBe(PreviewComposeFile.MAX_LENGTH);
    expect(PREVIEW_SERVICE_MAX_LENGTH).toBe(PreviewService.MAX_LENGTH);
    expect(PREVIEW_SERVICE_PATTERN.source).toBe(PreviewService.PATTERN.source);
    const { port } = savePreviewSettingsRequestSchema.shape;
    expect(port.minValue).toBe(PreviewPort.MIN);
    expect(port.maxValue).toBe(PreviewPort.MAX);
  });
});
