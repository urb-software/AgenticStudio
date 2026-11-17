// The aggregate's errors have a file of their own, so entry points can map them without
// importing a repository interface or an entity class.
export class InvalidProductNameError extends Error {}

export class ProductNameTakenError extends Error {}
