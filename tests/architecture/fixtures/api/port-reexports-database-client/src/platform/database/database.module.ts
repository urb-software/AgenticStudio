export interface DatabaseClient {
  projectNames(): Promise<string[]>;
}
