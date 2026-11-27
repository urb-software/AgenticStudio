import type { MergeMethod } from '../value-objects/merge-method.js';
import type { ProjectKind } from '../value-objects/project-kind.js';

/** What a Project is restored from. */
export interface ProjectData {
  readonly id: string;
  /** Display name: normalized (see `ProjectName`), case preserved. */
  readonly name: string;
  readonly mergeMethod: MergeMethod;
  /** Fixed when the Project is created. */
  readonly kind: ProjectKind;
  /** The agent a Run of the Project offers first; `null` when none is named. */
  readonly defaultAgent: string | null;
  /** The Workflow a Run offers first; exclusive with `defaultAgent`; absent means none. */
  readonly defaultWorkflow?: string | null;
  readonly createdAt: Date;
}
