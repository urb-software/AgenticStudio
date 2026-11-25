import { Inject, Injectable } from '@nestjs/common';
import {
  REPOSITORY_DISCONNECT_STEPS,
  type RepositoryDisconnectSteps,
} from '../../../projects/contracts/index.js';
import { DiscardAgentDraftForDisconnectHandler } from '../../application/features/discard-agent-draft-for-disconnect/handler.js';

/**
 * The driving adapter that adds the Draft's step to the Repository Disconnect of `projects`; it
 * holds no rule. It registers when it is built, before any start-up hook.
 */
@Injectable()
export class AgentDraftDisconnectStep {
  constructor(
    @Inject(REPOSITORY_DISCONNECT_STEPS) steps: RepositoryDisconnectSteps,
    handler: DiscardAgentDraftForDisconnectHandler,
  ) {
    steps.add({
      name: 'discard the agent Draft',
      run: (projectId) => handler.execute({ projectId }),
    });
  }
}
