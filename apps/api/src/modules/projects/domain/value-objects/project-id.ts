const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Project's id: a UUID. Anything else names no project. */
export type ProjectId = string & { readonly __projectId: unique symbol };

/** Whether `value` can be a project id (a UUID); anything else names no project. */
export function isProjectId(value: string): value is ProjectId {
  return UUID.test(value);
}
