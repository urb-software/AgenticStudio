const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` can be a project id (a UUID); anything else names no project. */
export function isProjectId(value: string): boolean {
  return UUID.test(value);
}
