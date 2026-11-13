import type { AppConfig } from '../config/config.js';

// Building a configuration writes secretsKey; that is not a read.
export const offlineConfig: AppConfig = { secretsKey: 'offline-placeholder' };
