import type { Metadata } from 'next';
import { ProjectsOverview } from '../../../modules/projects';

export const metadata: Metadata = { title: 'Projects · AI Agent Studio' };

export default function ProjectsPage() {
  return (
    // The Studio Shell provides the `main` landmark and the navigation (#43).
    <div className="flex flex-col gap-5">
      <ProjectsOverview />
    </div>
  );
}
