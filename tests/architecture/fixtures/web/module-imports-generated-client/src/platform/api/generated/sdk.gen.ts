export async function listProjects(): Promise<unknown> {
  return (await fetch('/api/projects')).json();
}
