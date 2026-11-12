'use client';

import { useProjects } from '../../api/projects-queries';

const createdAtFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** The operator's projects, newest first, with explicit loading, error and empty states. */
export function ProjectList() {
  const { data, isPending, isError } = useProjects();

  if (isPending) {
    return <p>Loading projects…</p>;
  }
  if (isError) {
    return <p role="alert">Could not load projects. Reload the page to try again.</p>;
  }
  if (data.items.length === 0) {
    return <p>No projects yet. Create your first project above.</p>;
  }
  return (
    <ul aria-label="Projects">
      {data.items.map((project) => (
        <li key={project.id}>
          <h3>{project.name}</h3>
          <p>
            Created{' '}
            <time dateTime={project.createdAt}>
              {createdAtFormat.format(new Date(project.createdAt))}
            </time>
          </p>
        </li>
      ))}
    </ul>
  );
}
