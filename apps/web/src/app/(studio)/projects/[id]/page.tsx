import type { Metadata } from 'next';
import { ProjectDetail } from '../../../../modules/projects';

export const metadata: Metadata = { title: 'Project · AI Agent Studio' };

export default async function ProjectPage({ params }: PageProps<'/projects/[id]'>) {
  const { id } = await params;
  return (
    // The Studio Shell provides the `main` landmark and the breadcrumb (#43, #60).
    <div className="flex flex-col gap-5">
      <ProjectDetail projectId={id} />
    </div>
  );
}
