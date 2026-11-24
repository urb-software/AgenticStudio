export const PREVIEW_SECRET_VALUES = Symbol('PREVIEW_SECRET_VALUES');

export interface PreviewSecretValues {
  /** The values a log of the operation must not show: its Environment file's. Empty when it holds none. */
  forOperation(operationId: string): Promise<string[]>;
}
