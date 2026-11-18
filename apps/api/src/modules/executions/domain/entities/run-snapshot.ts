import type { RunData } from './run-data.js';

/** The Run's current values as read-only plain data (rule 10); {@link Run.snapshot} produces it. */
export type RunSnapshot = Readonly<RunData>;
