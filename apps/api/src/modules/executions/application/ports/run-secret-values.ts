/** DI token of the {@link RunSecretValues} source. */
export const RUN_SECRET_VALUES = Symbol('RUN_SECRET_VALUES');

/**
 * The secret values known to be available to a Run (Issue #99), which log redaction replaces
 * wherever they appear: the values of the Run's Environment file snapshot (#104).
 */
export interface RunSecretValues {
  forRun(runId: string): Promise<string[]>;
}
