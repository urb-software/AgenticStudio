import { type DynamicModule, Module } from '@nestjs/common';
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
  ): DynamicModule {
    return {
      module: WorkflowsModule,
      imports: [projects, agents, executions],
      controllers: [ListWorkflowsEndpoint, GetWorkflowEndpoint],
      providers: [WorkflowsReader, ReadWorkflowsHandler, ReadWorkflowHandler],
    };
  }
}
