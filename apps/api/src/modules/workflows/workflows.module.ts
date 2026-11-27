import { type DynamicModule, Module } from '@nestjs/common';
import { WORKFLOW_PLANS } from '../executions/contracts/index.js';
import { WorkflowDefinitions } from './application/workflow-definitions.js';
import { DefinitionsWorkflowPlans } from './entry-points/contracts/workflow-plans.js';
import { ReadWorkflowHandler } from './application/features/read-workflow/handler.js';
import { ReadWorkflowsHandler } from './application/features/read-workflows/handler.js';
import { WorkflowsReader } from './application/workflows-reader.js';
import { GetWorkflowEndpoint } from './entry-points/http/operator/get-workflow/endpoint.js';
import { ListWorkflowsEndpoint } from './entry-points/http/operator/list-workflows/endpoint.js';

/**
 * `workflows` business module: the Workflows found in the definitions Repository, judged against
 * the agents their phases name and the Providers available now, through other modules' contracts.
 */
@Module({})
export class WorkflowsModule {
  static register(
    projects: DynamicModule,
    agents: DynamicModule,
    executions: DynamicModule,
    plans: DynamicModule,
  ): DynamicModule {
    return {
      module: WorkflowsModule,
      imports: [projects, agents, executions, plans],
      controllers: [ListWorkflowsEndpoint, GetWorkflowEndpoint],
      providers: [WorkflowsReader, ReadWorkflowsHandler, ReadWorkflowHandler],
    };
  }
}

/**
 * The part of `workflows` that `executions` is given: it provides {@link WORKFLOW_PLANS} and reads
 * the definitions through `projects` and `agents` only, so it needs nothing from `executions`
 * and the `executions` module imports nothing from `workflows`.
 */
@Module({})
export class WorkflowPlansModule {
  static register(projects: DynamicModule, agents: DynamicModule): DynamicModule {
    return {
      module: WorkflowPlansModule,
      imports: [projects, agents],
      providers: [
        WorkflowDefinitions,
        { provide: WORKFLOW_PLANS, useClass: DefinitionsWorkflowPlans },
      ],
      exports: [WorkflowDefinitions, WORKFLOW_PLANS],
    };
  }
}
