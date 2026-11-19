/**
 * The data an entity's `restore` takes, named without importing the entity's data type:
 * `RestoreData<typeof Run>`. Tests build entities with `restore` through this alias, so a rename of
 * the data type does not touch them.
 */
export type RestoreData<Entity extends { restore(data: never): unknown }> = Parameters<
  Entity['restore']
>[0];
