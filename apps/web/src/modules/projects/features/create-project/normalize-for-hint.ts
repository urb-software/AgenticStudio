/**
 * Mirror of the API's `normalizeProjectName` (NFC, then trim and whitespace collapse).
 * OpenAPI cannot express a normalization, so the generated hint cannot carry it; this copy
 * only keeps the client-side length hint in step with the API, which normalizes again and
 * stays the authority (docs/architecture/frontend.md §3). Parity with the API is pinned by
 * the shared test vector tests/fixtures/project-name-normalization.json, read by both suites.
 */
export function normalizeForHint(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/gu, ' ');
}
