const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Run's id: a UUID. Anything else names no Run. */
export type RunId = string & { readonly __runId: unique symbol };

/** Whether `value` can be a Run id (a UUID); anything else names no Run. */
export function isRunId(value: string): value is RunId {
  return UUID.test(value);
}
