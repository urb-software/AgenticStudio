import { type DynamicModule, Module } from '@nestjs/common';
import { GetDefinitionsRepositoryHandler } from './application/features/get-definitions-repository/handler.js';
import { ReadAgentsHandler } from './application/features/read-agents/handler.js';
import { GetAgentEndpoint } from './entry-points/http/operator/get-agent/endpoint.js';
import { GetDefinitionsRepositoryEndpoint } from './entry-points/http/operator/get-definitions-repository/endpoint.js';
import { ListAgentsEndpoint } from './entry-points/http/operator/list-agents/endpoint.js';

/**
 * `agents` business module: the definitions Repository's connection and the agents found in it,
 * as the Agents page shows them. It reaches the Repository only through the `projects` module's
 * public contract, which the composition root passes in.
 */
@Module({})
export class AgentsModule {
  static register(projects: DynamicModule): DynamicModule {
    return {
      module: AgentsModule,
      imports: [projects],
      // The fixed route first: `:name` would also match `definitions-repository`.
      controllers: [GetDefinitionsRepositoryEndpoint, ListAgentsEndpoint, GetAgentEndpoint],
      providers: [GetDefinitionsRepositoryHandler, ReadAgentsHandler],
    };
  }
}
