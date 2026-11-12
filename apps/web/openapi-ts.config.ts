import { defineConfig } from '@hey-api/openapi-ts';

// Generates the typed Fetch client, and Zod schemas of the request/response payloads
// (used by forms as client-side hints; the API stays authoritative), from the API's
// committed OpenAPI document. Run through `pnpm contracts:generate`; never edit the output.
export default defineConfig({
  input: '../api/openapi.json',
  output: { path: 'src/platform/api/generated' },
  plugins: ['@hey-api/typescript', '@hey-api/client-fetch', '@hey-api/sdk', 'zod'],
});
