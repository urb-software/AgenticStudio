import { DefinitionsProjectError } from '../errors/project-errors.js';
import type { AgentName } from '../value-objects/agent-name.js';
import type { MergeMethod } from '../value-objects/merge-method.js';
import type { ProjectKind } from '../value-objects/project-kind.js';
import type { ProjectData } from './project-data.js';

export class Project {
  readonly id: string;
  readonly name: string;
  readonly mergeMethod: MergeMethod;
  readonly kind: ProjectKind;
  readonly defaultAgent: string | null;
  readonly defaultWorkflow: string | null;
  readonly createdAt: Date;

  private constructor(data: ProjectData) {
    this.id = data.id;
    this.name = data.name;
    this.mergeMethod = data.mergeMethod;
    this.kind = data.kind;
    this.defaultAgent = data.defaultAgent;
    this.defaultWorkflow = data.defaultWorkflow ?? null;
    this.createdAt = new Date(data.createdAt);
  }

  static restore(data: ProjectData): Project {
    return new Project(data);
  }

  /**
   * Throws {@link DefinitionsProjectError}: the definitions Repository accepts no Environment file.
   */
  assertAcceptsEnvironmentFile(): void {
    if (this.kind === 'definitions') throw new DefinitionsProjectError();
  }

  /** The same Project with another merge method. */
  withMergeMethod(mergeMethod: MergeMethod): Project {
    return new Project({
      id: this.id,
      name: this.name,
      mergeMethod,
      kind: this.kind,
      defaultAgent: this.defaultAgent,
      defaultWorkflow: this.defaultWorkflow,
      createdAt: this.createdAt,
    });
  }

  /**
   * The same Project with another default agent (`null` names none). Throws
   * {@link DefinitionsProjectError}: the definitions Repository accepts no Run.
   */
  withDefaultAgent(agent: AgentName | null): Project {
    if (this.kind === 'definitions') throw new DefinitionsProjectError();
    return new Project({
      id: this.id,
      name: this.name,
      mergeMethod: this.mergeMethod,
      kind: this.kind,
      defaultAgent: agent?.value ?? null,
      defaultWorkflow: null,
      createdAt: this.createdAt,
    });
  }

  /**
   * The same Project with a Workflow as its default, which clears the default agent. Throws
   * {@link DefinitionsProjectError}: the definitions Repository accepts no Run.
   */
  withDefaultWorkflow(workflow: AgentName): Project {
    if (this.kind === 'definitions') throw new DefinitionsProjectError();
    return new Project({
      id: this.id,
      name: this.name,
      mergeMethod: this.mergeMethod,
      kind: this.kind,
      defaultAgent: null,
      defaultWorkflow: workflow.value,
      createdAt: this.createdAt,
    });
  }
}
