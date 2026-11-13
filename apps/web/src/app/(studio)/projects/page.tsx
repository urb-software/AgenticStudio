import type { Metadata } from 'next';
import { CreateProjectForm, ProjectList } from '../../../modules/projects';

export const metadata: Metadata = { title: 'Projects · AI Agent Studio' };

export default function ProjectsPage() {
  return (
    // The Studio Shell provides the `main` landmark and the navigation (#43).
    <div>
      <h1>Projects</h1>
      <section aria-labelledby="create-project-heading">
        <h2 id="create-project-heading">New project</h2>
        <CreateProjectForm />
      </section>
      <section aria-labelledby="project-list-heading">
        <h2 id="project-list-heading">Your projects</h2>
        <ProjectList />
      </section>
    </div>
  );
}
