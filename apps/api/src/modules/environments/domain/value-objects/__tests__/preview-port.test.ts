import { describe, expect, it } from 'vitest';
import { InvalidPreviewPortError, PreviewPort } from '../preview-port.js';

describe('PreviewPort', () => {
  it.each([1, 80, 3000, 65535])('accepts %d', (port) => {
    expect(PreviewPort.of(port).value).toBe(port);
  });

  it.each([0, -1, 65536, 3000.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %d', (port) => {
    expect(() => PreviewPort.of(port)).toThrow(InvalidPreviewPortError);
  });
});
