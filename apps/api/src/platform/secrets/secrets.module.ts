import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaSecretStore } from './prisma-secret-store.js';
import { SECRET_STORE } from './secret-store.js';

/**
 * Provides the {@link SECRET_STORE} port (ADR 0001). A business module that needs secrets
 * imports this module in its {module}.module.ts and injects the port from `./index.js`.
 */
@Module({
  imports: [DatabaseModule],
  providers: [{ provide: SECRET_STORE, useClass: PrismaSecretStore }],
  exports: [SECRET_STORE],
})
export class SecretsModule {}
