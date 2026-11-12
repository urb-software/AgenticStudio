import { defineConfig } from '@hey-api/openapi-ts';

// Generates the typed Fetch client from the API's committed OpenAPI document.
// Run through `pnpm contracts:generate`; never edit the output by hand.
export default defineConfig({
  input: '../api/openapi.json',
  output: { path: 'src/platform/api/generated' },
  plugins: ['@hey-api/typescript', '@hey-api/client-fetch', '@hey-api/sdk'],
});
