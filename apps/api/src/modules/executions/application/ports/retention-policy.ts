import type { RetentionPolicy } from '../../domain/value-objects/retention-policy.js';

export type { RetentionPolicy };

/** DI token of the {@link RetentionPolicy} setting (the `STUDIO_RETENTION_*` settings). */
export const RETENTION_POLICY = Symbol('RETENTION_POLICY');
