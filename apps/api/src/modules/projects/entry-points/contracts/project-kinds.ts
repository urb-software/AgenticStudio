import { Injectable } from '@nestjs/common';
import type { ProjectKind, ProjectKinds } from '../../contracts/index.js';
import { GetProjectKindHandler } from '../../application/features/get-project-kind/handler.js';

/** The driving adapter of {@link ProjectKinds}: it maps the call to the handler and holds no rule. */
@Injectable()
export class ProjectProjectKinds implements ProjectKinds {
  constructor(private readonly handler: GetProjectKindHandler) {}

  kindOf(projectId: string): Promise<ProjectKind | null> {
    return this.handler.execute({ projectId });
  }
}
