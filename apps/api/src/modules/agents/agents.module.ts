import { type DynamicModule, Module } from '@nestjs/common';
import { GetDefinitionsRepositoryHandler } from './application/features/get-definitions-repository/handler.js';
import { GetDefinitionsRepositoryEndpoint } from './entry-points/http/operator/get-definitions-repository/endpoint.js';

/**
 * `agents` business module: the definitions Repository's connection as the Agents page shows it.
 * It reaches the Repository only through the `projects` module's public contract, which the
 * composition root passes in.
 */
@Module({})
export class AgentsModule {
  static register(projects: DynamicModule): DynamicModule {
    return {
      module: AgentsModule,
      imports: [projects],
      controllers: [GetDefinitionsRepositoryEndpoint],
      providers: [GetDefinitionsRepositoryHandler],
    };
  }
}
