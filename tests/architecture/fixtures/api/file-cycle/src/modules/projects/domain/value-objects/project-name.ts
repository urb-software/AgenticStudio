import type { Project } from '../entities/project.js';

export type ProjectName = string & { readonly owner?: Project };
