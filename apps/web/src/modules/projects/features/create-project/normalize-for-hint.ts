/**
 * Mirror of the API's `normalizeProjectName`: OpenAPI cannot express a normalization, so the
 * generated hint cannot carry it. Parity is pinned by
 * tests/fixtures/project-name-normalization.json, read by both suites (frontend.md §3).
 */
export function normalizeForHint(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ');
}
