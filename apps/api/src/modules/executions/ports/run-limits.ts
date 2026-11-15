import type { RunLimits } from '../domain/entities/run.js';

/** DI token of the {@link RunLimitsSetting}. */
export const RUN_LIMITS = Symbol('RUN_LIMITS');

/**
 * The limits copied onto every new Run (Issue #100), from the API's configuration:
 * `STUDIO_RUN_STEP_MINUTES` (60), `STUDIO_RUN_MAX_STEPS` (10), `STUDIO_RUN_WAITING_DAYS` (14).
 */
export type RunLimitsSetting = Readonly<RunLimits>;
