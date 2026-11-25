import { Injectable } from '@nestjs/common';
import type { ProjectKind, ProjectKinds } from '../../contracts/index.js';
import { GetDefinitionsProjectIdHandler } from '../../application/features/get-definitions-project-id/handler.js';
import { GetProjectKindHandler } from '../../application/features/get-project-kind/handler.js';

/** The driving adapter of {@link ProjectKinds}: it maps each call to a handler and holds no rule. */
@Injectable()
export class ProjectProjectKinds implements ProjectKinds {
  constructor(
    private readonly kind: GetProjectKindHandler,
    private readonly definitions: GetDefinitionsProjectIdHandler,
  ) {}

  kindOf(projectId: string): Promise<ProjectKind | null> {
    return this.kind.execute({ projectId });
  }

  definitionsProjectId(): Promise<string | null> {
    return this.definitions.execute();
  }
}
