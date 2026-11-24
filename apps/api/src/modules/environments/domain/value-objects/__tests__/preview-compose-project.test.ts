import { describe, expect, it } from 'vitest';
import { PreviewComposeProject } from '../preview-compose-project.js';
import { PreviewHostname } from '../preview-hostname.js';

const PROJECT = '3F2B8C1E-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('PreviewComposeProject', () => {
  it('names the Compose project from the whole id and the label from its first 12 digits', () => {
    const names = PreviewComposeProject.of(PROJECT);

    expect(names.value).toBe('preview-3f2b8c1e4d5a4b6c9d7e8f9a0b1c2d3e');
    expect(names.value).toMatch(/^preview-[0-9a-f]{32}$/);
    expect(names.label).toBe('preview-3f2b8c1e4d5a');
  });

  it('gives the label the hostname starts with', () => {
    expect(
      PreviewHostname.of(PROJECT, 'example.test').value.startsWith(
        `${PreviewComposeProject.of(PROJECT).label}.`,
      ),
    ).toBe(true);
  });
});
