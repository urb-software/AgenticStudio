import type { RunData } from './run-data.js';

/** The Run's current values as read-only plain data; {@link Run.snapshot} produces it. */
export type RunSnapshot = Readonly<RunData>;
