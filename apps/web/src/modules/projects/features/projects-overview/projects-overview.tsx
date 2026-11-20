'use client';

import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/shared/ui/button';
import { CreateProjectDialog } from '../create-project/create-project-dialog';
import { ProjectList } from '../project-list/project-list';

export function ProjectsOverview() {
  const [creating, setCreating] = useState(false);
  const openCreate = () => setCreating(true);

  return (
    <>
      <div className="flex flex-col items-start gap-3 md:flex-row md:items-end md:justify-between">
        <h1 className="m-0 text-page-title font-semibold tracking-[-0.015em]">Projects</h1>
        <Button variant="primary" icon={PlusIcon} onClick={openCreate}>
          New project
        </Button>
      </div>
      <ProjectList onCreateProject={openCreate} />
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
