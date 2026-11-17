export class RunNotFoundError extends Error {}

export interface RunRepository {
  count(): Promise<number>;
}
