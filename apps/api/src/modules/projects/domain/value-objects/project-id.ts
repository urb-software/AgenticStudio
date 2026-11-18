const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProjectId = string & { readonly __projectId: unique symbol };

export function isProjectId(value: string): value is ProjectId {
  return UUID.test(value);
}
