export const RUN_SECRET_VALUES = Symbol('RUN_SECRET_VALUES');

export interface RunSecretValues {
  forRun(runId: string): Promise<string[]>;
}
