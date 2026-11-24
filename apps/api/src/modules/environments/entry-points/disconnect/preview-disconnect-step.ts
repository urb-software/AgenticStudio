import { Inject, Injectable } from '@nestjs/common';
import {
  REPOSITORY_DISCONNECT_STEPS,
  type RepositoryDisconnectSteps,
} from '../../../projects/contracts/index.js';
import { RemovePreviewForDisconnectHandler } from '../../application/features/remove-preview-for-disconnect/handler.js';

/**
 * The driving adapter that adds the Preview's step to the Repository Disconnect of `projects`;
 * it holds no rule. It registers when it is built, which Nest does for every provider before any
 * start-up hook, so the start-up resume of a disconnecting Repository already runs it.
 */
@Injectable()
export class PreviewDisconnectStep {
  constructor(
    @Inject(REPOSITORY_DISCONNECT_STEPS) steps: RepositoryDisconnectSteps,
    handler: RemovePreviewForDisconnectHandler,
  ) {
    steps.add({
      name: 'remove the Preview',
      run: (projectId) => handler.execute({ projectId }),
    });
  }
}
