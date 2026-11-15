/** DI token of the {@link RunSecretValues} source. */
export const RUN_SECRET_VALUES = Symbol('RUN_SECRET_VALUES');

/**
 * The secret values known to be available to a Run (Issue #99), which log redaction replaces
 * wherever they appear. Empty until Environment files (#104) supply their values; the hook
 * exists so redaction does not change shape then.
 */
export interface RunSecretValues {
  forRun(runId: string): Promise<string[]>;
}
