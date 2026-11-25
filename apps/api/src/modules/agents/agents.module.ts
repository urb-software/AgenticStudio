import { type DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { AgentDraftBaseReader } from './application/agent-draft-base.js';
import { AgentDraftReader } from './application/agent-draft-reader.js';
import { DeleteAgentDraftFileHandler } from './application/features/delete-agent-draft-file/handler.js';
import { DiscardAgentDraftHandler } from './application/features/discard-agent-draft/handler.js';
import { GetAgentDraftHandler } from './application/features/get-agent-draft/handler.js';
import { GetDefinitionsRepositoryHandler } from './application/features/get-definitions-repository/handler.js';
import { ListAgentFilesHandler } from './application/features/list-agent-files/handler.js';
import { MoveAgentDraftFileHandler } from './application/features/move-agent-draft-file/handler.js';
import { ReadAgentDraftFileHandler } from './application/features/read-agent-draft-file/handler.js';
import { SaveAgentDraftFileHandler } from './application/features/save-agent-draft-file/handler.js';
import { ReadAgentFileHandler } from './application/features/read-agent-file/handler.js';
import { ReadAgentsHandler } from './application/features/read-agents/handler.js';
import { DeleteAgentDraftFileEndpoint } from './entry-points/http/operator/delete-agent-draft-file/endpoint.js';
import { DiscardAgentDraftEndpoint } from './entry-points/http/operator/discard-agent-draft/endpoint.js';
import { GetAgentDraftEndpoint } from './entry-points/http/operator/get-agent-draft/endpoint.js';
import { GetAgentDraftFileEndpoint } from './entry-points/http/operator/get-agent-draft-file/endpoint.js';
import { MoveAgentDraftFileEndpoint } from './entry-points/http/operator/move-agent-draft-file/endpoint.js';
import { SaveAgentDraftFileEndpoint } from './entry-points/http/operator/save-agent-draft-file/endpoint.js';
import { GetAgentFileEndpoint } from './entry-points/http/operator/get-agent-file/endpoint.js';
import { ReadAgentsAgentResolutions } from './entry-points/contracts/agent-resolutions.js';
import { ListRunAgentsEndpoint } from './entry-points/http/operator/list-run-agents/endpoint.js';
import { AGENT_RESOLUTION } from './contracts/index.js';
import { AGENT_DRAFT_REPOSITORY } from './domain/repositories/agent-draft-repository.js';
import { PrismaAgentDraftRepository } from './infrastructure/repositories/prisma-agent-draft-repository.js';
import { GetAgentEndpoint } from './entry-points/http/operator/get-agent/endpoint.js';
import { GetDefinitionsRepositoryEndpoint } from './entry-points/http/operator/get-definitions-repository/endpoint.js';
import { ListAgentFilesEndpoint } from './entry-points/http/operator/list-agent-files/endpoint.js';
import { ListAgentsEndpoint } from './entry-points/http/operator/list-agents/endpoint.js';

/**
 * `agents` business module: the agents found in the definitions Repository, the agents a Run can
 * start with, and the Draft of unpublished changes to the definition files, which reaches no
 * agent. It reaches the Repository and the Projects only through the `projects` module's public
 * contract, which the composition root passes in.
 */
@Module({})
export class AgentsModule {
  static register(projects: DynamicModule): DynamicModule {
    return {
      module: AgentsModule,
      imports: [DatabaseModule, projects],
      // The fixed route first: `:name` would also match `definitions-repository`.
      controllers: [
        GetDefinitionsRepositoryEndpoint,
        ListAgentFilesEndpoint,
        GetAgentFileEndpoint,
        GetAgentDraftEndpoint,
        GetAgentDraftFileEndpoint,
        SaveAgentDraftFileEndpoint,
        MoveAgentDraftFileEndpoint,
        DeleteAgentDraftFileEndpoint,
        DiscardAgentDraftEndpoint,
        ListAgentsEndpoint,
        GetAgentEndpoint,
        ListRunAgentsEndpoint,
      ],
      providers: [
        GetDefinitionsRepositoryHandler,
        ReadAgentsHandler,
        ListAgentFilesHandler,
        ReadAgentFileHandler,
        AgentDraftBaseReader,
        AgentDraftReader,
        GetAgentDraftHandler,
        ReadAgentDraftFileHandler,
        SaveAgentDraftFileHandler,
        MoveAgentDraftFileHandler,
        DeleteAgentDraftFileHandler,
        DiscardAgentDraftHandler,
        { provide: AGENT_DRAFT_REPOSITORY, useClass: PrismaAgentDraftRepository },
        { provide: AGENT_RESOLUTION, useClass: ReadAgentsAgentResolutions },
      ],
      exports: [AGENT_RESOLUTION],
    };
  }
}
