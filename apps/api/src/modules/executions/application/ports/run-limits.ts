import type { RunLimits } from '../../domain/value-objects/run-limits.js';

export const RUN_LIMITS = Symbol('RUN_LIMITS');

export type RunLimitsSetting = Readonly<RunLimits>;
