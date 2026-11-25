import type { ProjectKind, ProjectKinds } from '../../../../projects/contracts/index.js';

/** A scripted {@link ProjectKinds}: every Project is an ordinary one unless a test says otherwise. */
export class FakeProjectKinds implements ProjectKinds {
  kind: ProjectKind | null = 'code';

  kindOf(): Promise<ProjectKind | null> {
    return Promise.resolve(this.kind);
  }
}
