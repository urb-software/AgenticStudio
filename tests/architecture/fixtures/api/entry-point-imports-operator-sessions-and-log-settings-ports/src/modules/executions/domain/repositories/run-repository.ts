export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');

export class RunNotFoundError extends Error {}

export interface RunRepository {
  count(): Promise<number>;
}
