const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunId = string & { readonly __runId: unique symbol };

export function isRunId(value: string): value is RunId {
  return UUID.test(value);
}
