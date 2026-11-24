const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PreviewOperationId = string & { readonly __previewOperationId: unique symbol };

/** Whether the text can be an operation's id; any other text names no operation. */
export function isPreviewOperationId(value: string): value is PreviewOperationId {
  return UUID.test(value);
}
