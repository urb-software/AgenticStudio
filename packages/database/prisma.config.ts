import { existsSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env files. For local development, load the repo-root
// .env (copied from .env.example) if present; variables already set in the
// environment take precedence.
const rootEnvFile = path.resolve(import.meta.dirname, '../../.env');
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Only migrate commands need it; `prisma generate` works without a database.
    url: process.env.DATABASE_URL ?? '',
  },
});
