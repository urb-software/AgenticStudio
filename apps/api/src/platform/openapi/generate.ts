import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppModule } from '../../app.module.js';
import { buildApp } from '../../app.js';
import { createOpenApiDocument } from './openapi.js';

// Offline generator for `pnpm contracts:generate`: builds the app without listening
// and without a database (the client connects lazily), then writes the document.
// The placeholder config is never used to connect anywhere.
const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error('Usage: node dist/platform/openapi/generate.js <output.json>');
}

const app = await buildApp(
  AppModule.register({
    apiPort: 0,
    apiOrigin: 'http://localhost:3001',
    databaseUrl: 'postgresql://offline:offline@127.0.0.1:1/offline',
  }),
  { logger: false },
);
await app.init();
const document = createOpenApiDocument(app);
await app.close();

await writeFile(resolve(outputPath), `${JSON.stringify(document, null, 2)}\n`);
