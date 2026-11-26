import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config.js';
import { DatabaseModule } from '../../platform/database/database.module.js';
import { AgentDraftBaseReader } from './application/agent-draft-base.js';
import { AgentDraftReader } from './application/agent-draft-reader.js';
import { DeleteAgentDraftFileHandler } from './application/features/delete-agent-draft-file/handler.js';
import { DiscardAgentDraftForDisconnectHandler } from './application/features/discard-agent-draft-for-disconnect/handler.js';
import { RevertAgentDraftFileHandler } from './application/features/revert-agent-draft-file/handler.js';
import { DiscardAgentDraftHandler } from './application/features/discard-agent-draft/handler.js';
import { GetAgentDraftHandler } from './application/features/get-agent-draft/handler.js';
import { GetDefinitionsRepositoryHandler } from './application/features/get-definitions-repository/handler.js';
import { ListAgentFilesHandler } from './application/features/list-agent-files/handler.js';
import { MoveAgentDraftFileHandler } from './application/features/move-agent-draft-file/handler.js';
import { PublishAgentDraftHandler } from './application/features/publish-agent-draft/handler.js';
import { DEFINITIONS_COMMIT_IDENTITY } from './application/ports/commit-identity.js';
import { PUBLISH_LOCK } from './application/ports/publish-lock.js';
import { PrismaPublishLock } from './infrastructure/repositories/prisma-publish-lock.js';
import { PublishAgentDraftEndpoint } from './entry-points/http/operator/publish-agent-draft/endpoint.js';
import { ReadAgentDraftFileHandler } from './application/features/read-agent-draft-file/handler.js';
import { SaveAgentDraftFileHandler } from './application/features/save-agent-draft-file/handler.js';
import { ReadAgentFileHandler } from './application/features/read-agent-file/handler.js';
import { AgentsReader } from './application/agents-reader.js';
import { SkillsReader } from './application/skills-reader.js';
import { ReadSkillsHandler } from './application/features/read-skills/handler.js';
import { ReadAgentsHandler } from './application/features/read-agents/handler.js';
import { ReadAgentFolderHandler } from './application/features/read-agent-folder/handler.js';
import { ReadAgentFolderAgentFolders } from './entry-points/contracts/agent-folders.js';
import { ReadRunSkillsHandler } from './application/features/read-run-skills/handler.js';
import { ReadRunSkillsAgentSkills } from './entry-points/contracts/agent-skills.js';
import { GetAgentFileEndpoint } from './entry-points/http/operator/get-agent-file/endpoint.js';
import { ReadAgentsAgentResolutions } from './entry-points/contracts/agent-resolutions.js';
import { ListRunAgentsEndpoint } from './entry-points/http/operator/list-run-agents/endpoint.js';
import { AGENT_FOLDERS, AGENT_RESOLUTION, AGENT_SKILLS } from './contracts/index.js';
import { AgentDraftDisconnectStep } from './entry-points/disconnect/agent-draft-disconnect-step.js';
import { RevertAgentDraftFileEndpoint } from './entry-points/http/operator/revert-agent-draft-file/endpoint.js';
import { DeleteAgentDraftFileEndpoint } from './entry-points/http/operator/delete-agent-draft-file/endpoint.js';
import { DiscardAgentDraftEndpoint } from './entry-points/http/operator/discard-agent-draft/endpoint.js';
import { GetAgentDraftEndpoint } from './entry-points/http/operator/get-agent-draft/endpoint.js';
import { GetAgentDraftFileEndpoint } from './entry-points/http/operator/get-agent-draft-file/endpoint.js';
import { MoveAgentDraftFileEndpoint } from './entry-points/http/operator/move-agent-draft-file/endpoint.js';
import { SaveAgentDraftFileEndpoint } from './entry-points/http/operator/save-agent-draft-file/endpoint.js';
import { AGENT_DRAFT_REPOSITORY } from './domain/repositories/agent-draft-repository.js';
import { PrismaAgentDraftRepository } from './infrastructure/repositories/prisma-agent-draft-repository.js';
import { GetAgentEndpoint } from './entry-points/http/operator/get-agent/endpoint.js';
import { GetDefinitionsRepositoryEndpoint } from './entry-points/http/operator/get-definitions-repository/endpoint.js';
import { ListAgentFilesEndpoint } from './entry-points/http/operator/list-agent-files/endpoint.js';
import { GetSkillEndpoint } from './entry-points/http/operator/get-skill/endpoint.js';
import { ListSkillsEndpoint } from './entry-points/http/operator/list-skills/endpoint.js';
import { ListAgentsEndpoint } from './entry-points/http/operator/list-agents/endpoint.js';

/**
 * `agents` business module: the agents found in the definitions Repository, the agents a Run can
 * start with, and the Draft of unpublished changes, which reaches no agent. It reaches the
 * Repository and the Projects only through the `projects` module's public contract.
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
        RevertAgentDraftFileEndpoint,
        DiscardAgentDraftEndpoint,
        PublishAgentDraftEndpoint,
        ListAgentsEndpoint,
        GetAgentEndpoint,
        ListRunAgentsEndpoint,
        ListSkillsEndpoint,
        GetSkillEndpoint,
      ],
      providers: [
        GetDefinitionsRepositoryHandler,
        AgentsReader,
        SkillsReader,
        ReadAgentsHandler,
        ReadSkillsHandler,
        ReadAgentFolderHandler,
        ReadRunSkillsHandler,
        ListAgentFilesHandler,
        ReadAgentFileHandler,
        AgentDraftBaseReader,
        AgentDraftReader,
        GetAgentDraftHandler,
        ReadAgentDraftFileHandler,
        SaveAgentDraftFileHandler,
        MoveAgentDraftFileHandler,
        DeleteAgentDraftFileHandler,
        RevertAgentDraftFileHandler,
        DiscardAgentDraftForDisconnectHandler,
        AgentDraftDisconnectStep,
        DiscardAgentDraftHandler,
        PublishAgentDraftHandler,
        { provide: PUBLISH_LOCK, useClass: PrismaPublishLock },
        {
          // Studio's settings only; read per call so a missing identity answers 503, not a crash.
          provide: DEFINITIONS_COMMIT_IDENTITY,
          useFactory: (config: AppConfig) => ({ get: () => config.definitionsCommitIdentity }),
          inject: [APP_CONFIG],
        },
        { provide: AGENT_DRAFT_REPOSITORY, useClass: PrismaAgentDraftRepository },
        { provide: AGENT_RESOLUTION, useClass: ReadAgentsAgentResolutions },
        { provide: AGENT_FOLDERS, useClass: ReadAgentFolderAgentFolders },
        { provide: AGENT_SKILLS, useClass: ReadRunSkillsAgentSkills },
      ],
      exports: [AGENT_RESOLUTION, AGENT_FOLDERS, AGENT_SKILLS],
    };
  }
}
