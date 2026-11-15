export async function startPostgres(): Promise<{ url: string }> {
  return { url: 'postgres://localhost/test' };
}
