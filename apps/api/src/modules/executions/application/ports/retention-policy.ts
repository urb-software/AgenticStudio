import type { RetentionPolicy } from '../../domain/services/retention.js';

export type { RetentionPolicy };

/** DI token of the {@link RetentionPolicy} setting (the `STUDIO_RETENTION_*` settings). */
export const RETENTION_POLICY = Symbol('RETENTION_POLICY');
