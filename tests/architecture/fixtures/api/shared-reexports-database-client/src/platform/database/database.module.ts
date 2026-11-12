export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');

export interface DatabaseClient {
  projectNames(): Promise<string[]>;
}
