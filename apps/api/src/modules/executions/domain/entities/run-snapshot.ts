import type { RunData } from './run-data.js';

/** The Run's current values; {@link Run.snapshot} produces it. */
export type RunSnapshot = Readonly<RunData>;
