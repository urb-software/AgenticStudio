import type { Project as ProjectRow } from '@prisma/client';

export type Project = Pick<ProjectRow, 'id' | 'name'>;
