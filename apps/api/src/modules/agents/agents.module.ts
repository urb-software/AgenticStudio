import { type DynamicModule, Module } from '@nestjs/common';
import { GetDefinitionsRepositoryHandler } from './application/features/get-definitions-repository/handler.js';
import { ReadAgentsHandler } from './application/features/read-agents/handler.js';
import { ReadAgentFolderHandler } from './application/features/read-agent-folder/handler.js';
import { ReadAgentFolderAgentFolders } from './entry-points/contracts/agent-folders.js';
import { ReadAgentsAgentResolutions } from './entry-points/contracts/agent-resolutions.js';
import { ListRunAgentsEndpoint } from './entry-points/http/operator/list-run-agents/endpoint.js';
import { AGENT_FOLDERS, AGENT_RESOLUTION } from './contracts/index.js';
import { GetAgentEndpoint } from './entry-points/http/operator/get-agent/endpoint.js';
import { GetDefinitionsRepositoryEndpoint } from './entry-points/http/operator/get-definitions-repository/endpoint.js';
import { ListAgentsEndpoint } from './entry-points/http/operator/list-agents/endpoint.js';

/**
 * `agents` business module: the agents found in the definitions Repository and the agents a Run
 * can start with. It reaches the Repository and the Projects only through the `projects` module's
 * public contract, which the composition root passes in.
 */
@Module({})
export class AgentsModule {
  static register(projects: DynamicModule): DynamicModule {
    return {
      module: AgentsModule,
      imports: [projects],
      // The fixed route first: `:name` would also match `definitions-repository`.
      controllers: [
        GetDefinitionsRepositoryEndpoint,
        ListAgentsEndpoint,
        GetAgentEndpoint,
        ListRunAgentsEndpoint,
      ],
      providers: [
        GetDefinitionsRepositoryHandler,
        ReadAgentsHandler,
        ReadAgentFolderHandler,
        { provide: AGENT_RESOLUTION, useClass: ReadAgentsAgentResolutions },
        { provide: AGENT_FOLDERS, useClass: ReadAgentFolderAgentFolders },
      ],
      exports: [AGENT_RESOLUTION, AGENT_FOLDERS],
    };
  }
}
