import type { Project } from './project.js';

export type ProjectName = string & { readonly owner?: Project };
