export async function getJson(path: string): Promise<unknown> {
  const response = await fetch('/api' + path, { credentials: 'include' });
  return response.json();
}
