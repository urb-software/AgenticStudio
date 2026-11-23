import type { Metadata } from 'next';
import { PreviewPage } from '../../../../../modules/environments';

export const metadata: Metadata = { title: 'Preview · AI Agent Studio' };

export default async function ProjectPreviewPage({ params }: PageProps<'/projects/[id]/preview'>) {
  const { id } = await params;
  return (
    // The Studio Shell provides the `main` landmark and the breadcrumb.
    <div className="flex flex-col gap-5">
      <PreviewPage projectId={id} />
    </div>
  );
}
