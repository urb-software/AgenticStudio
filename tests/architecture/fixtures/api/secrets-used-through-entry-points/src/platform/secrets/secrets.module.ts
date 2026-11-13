import { PrismaSecretStore } from './prisma-secret-store.js';
import { SECRET_STORE } from './secret-store.js';

export const SecretsModule = { provide: SECRET_STORE, useClass: PrismaSecretStore };
