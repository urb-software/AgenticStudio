export interface DatabaseClient {
  project: { create(args: { data: { name: string } }): Promise<unknown> };
}
