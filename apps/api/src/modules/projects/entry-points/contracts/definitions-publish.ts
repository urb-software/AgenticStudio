import { Injectable } from '@nestjs/common';
import type {
  DefinitionsPublish,
  DefinitionsPublishInput,
  DefinitionsPublishResult,
} from '../../contracts/index.js';
import { PublishDefinitionsHandler } from '../../application/features/publish-definitions/handler.js';

/**
 * The driving adapter of {@link DefinitionsPublish}: it maps the call to the handler and holds no
 * rule.
 */
@Injectable()
export class ProjectDefinitionsPublish implements DefinitionsPublish {
  constructor(private readonly handler: PublishDefinitionsHandler) {}

  publish(input: DefinitionsPublishInput): Promise<DefinitionsPublishResult> {
    return this.handler.execute(input);
  }
}
