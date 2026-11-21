import type { MergeMethod } from '../value-objects/merge-method.js';
import type { ProjectData } from './project-data.js';

export class Project {
  readonly id: string;
  readonly name: string;
  /** How the Project's Runs are merged; applies to merges approved after it is set. */
  readonly mergeMethod: MergeMethod;
  readonly createdAt: Date;

  private constructor(data: ProjectData) {
    this.id = data.id;
    this.name = data.name;
    this.mergeMethod = data.mergeMethod;
    this.createdAt = new Date(data.createdAt);
  }

  static restore(data: ProjectData): Project {
    return new Project(data);
  }

  /** The same Project with another merge method; it applies to merges approved afterwards. */
  withMergeMethod(mergeMethod: MergeMethod): Project {
    return new Project({
      id: this.id,
      name: this.name,
      mergeMethod,
      createdAt: this.createdAt,
    });
  }
}
